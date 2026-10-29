/**
 * The tile grid and its ring: the grid's shape at the user's sizes, the
 * ring's order and capacity, a photo's native test, the glyph calls each tile
 * makes, the font cap, and the plumbing exactly (a print fed by tile sources
 * whose loaders slice known fields is the print fed the fields whole: a ring,
 * offset or eviction bug shows here as a difference, with no rasteriser in
 * the way).
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { BAND_PIXELS, CANVAS_FONT_MAX, MIN_BAND_ROWS, TILE_EDGE, TILE_PIXELS, bandHeight } from './limits.ts'
import { TiledGroundRows, TiledTones, isNativeRect, printSheet, sampledNoise, type ToneSource, type TonePass } from './render.ts'
import { drawBacking, drawGlyphs, fontCapFactor, lineRects, planGlyphs } from './text.ts'
import { TILE_BUDGET, TileRowCache, ringRows, rowsFromTiles, tileAt, tileGrid } from './tiles.ts'
import { areaOf, coverRect, snapRect } from './media.ts'
import type { PrintSettings, TextLayer } from './types.ts'
import { makeGround } from './__tests__/fields.ts'
import { DOCS, syntheticTones } from './__tests__/documents.ts'

const sha = (b: Uint8Array | Uint8ClampedArray) => createHash('sha256').update(b).digest('hex')

describe('the grid', () => {
  it('the knobs: 4096 wide, 2^22 pixels a tile, 2^21 a band, 32 rows at least', () => {
    expect([TILE_EDGE, TILE_PIXELS, BAND_PIXELS, MIN_BAND_ROWS, CANVAS_FONT_MAX]).toEqual([4096, 4194304, 2097152, 32, 9216])
    expect(TILE_BUDGET).toEqual({ edge: 4096, pixels: 4194304 })
  })

  it('one tile up to 4.19 MP and 4096 wide; the user\'s sizes in 4096 x 1024 tiles', () => {
    const shape = (w: number, h: number) => {
      const g = tileGrid(w, h)
      return [g.tileW, g.tileH, g.cols, g.rows]
    }
    // The reference sheet and a 4096 x 1024 sheet: one tile each.
    expect(shape(1440, 1800)).toEqual([1440, 2912, 1, 1])
    expect(shape(4096, 1024)).toEqual([4096, 1024, 1, 1])
    // 40 MP on Original: 2 x 6 tiles; 61 MP: 3 x 7.
    expect(shape(7728, 5152)).toEqual([4096, 1024, 2, 6])
    expect(shape(9504, 6336)).toEqual([4096, 1024, 3, 7])
    // Narrower than 4096: one column, as tall as the pixels allow.
    expect(shape(4122, 5152)).toEqual([4096, 1024, 2, 6])
    expect(shape(2419, 3024)).toEqual([2419, 1733, 1, 2])
    expect(shape(3651, 10954)).toEqual([3651, 1148, 1, 10])
  })

  it('tiles are clipped to the sheet at the last column and row', () => {
    const g = tileGrid(7728, 5152)
    expect(tileAt(g, 0, 0)).toEqual({ cx: 0, ty: 0, x0: 0, y0: 0, w: 4096, h: 1024 })
    expect(tileAt(g, 1, 5)).toEqual({ cx: 1, ty: 5, x0: 4096, y0: 5120, w: 3632, h: 32 })
    // Forced small tiles (the test seam): 512 x 128.
    const f = tileGrid(800, 1000, { edge: 512, pixels: 65536 })
    expect([f.tileW, f.tileH, f.cols, f.rows]).toEqual([512, 128, 2, 8])
  })

  it('the band: BAND_PIXELS over the width, at least 32 rows, at most the sheet', () => {
    expect(bandHeight(7728, 5152)).toBe(271)
    expect(bandHeight(9504, 6336)).toBe(220)
    expect(bandHeight(4122, 5152)).toBe(508)
    // Every preview (at most a megapixel) is one band.
    expect(bandHeight(1000, 1000)).toBe(1000)
    expect(bandHeight(1732, 577)).toBe(577)
    expect(bandHeight(100_000, 400)).toBe(32)
  })
})

describe('the ring of tile rows', () => {
  const grid = tileGrid(10, 100, { edge: 10, pixels: 100 }) // 10 x 10 tiles, 10 rows of them

  it('holds a window\'s tile rows at once: a window of 1,260 rows on 1,148-row tiles spans 3', () => {
    const g = tileGrid(3651, 10954)
    expect(g.tileH).toBe(1148)
    expect(ringRows(g, 1260)).toBe(3)
    expect(ringRows(g, 308)).toBe(2)
    // Never more rows than the grid has.
    expect(ringRows(tileGrid(800, 1000), 2000)).toBe(1)
  })

  it('evicts the least recently used row; a row given up is drawn again', () => {
    const drawn: number[] = []
    const cache = new TileRowCache(2, () => ({ ty: -1 }), (ty, slot) => {
      drawn.push(ty)
      slot.ty = ty
    })
    expect(cache.row(0).ty).toBe(0)
    expect(cache.row(1).ty).toBe(1)
    expect(cache.row(0).ty).toBe(0) // held
    expect(cache.row(2).ty).toBe(2) // evicts 1, the least recently used
    expect(drawn).toEqual([0, 1, 2])
    // 2 and 0 are held: nothing drawn, and 2 is now the least recently used.
    expect(cache.row(2).ty).toBe(2)
    expect(cache.row(0).ty).toBe(0)
    expect(drawn).toEqual([0, 1, 2])
    expect(cache.row(1).ty).toBe(1) // evicts 2
    expect(cache.row(0).ty).toBe(0) // held
    expect(cache.row(2).ty).toBe(2) // drawn again, evicting 1
    expect(drawn).toEqual([0, 1, 2, 1, 2])
    expect(cache.loads).toBe(5)
  })

  it('after a sequential pass over the sheet (the photo\'s luminance), the first band\'s row is drawn again', () => {
    const drawn: number[] = []
    const cache = new TileRowCache(ringRows(grid, 7), () => new Uint8Array(10 * 10), (ty) => drawn.push(ty))
    for (let y0 = 0; y0 < 100; y0 += 7) rowsFromTiles(grid, cache, 1, new Uint8Array(70), y0, Math.min(100, y0 + 7))
    expect(drawn).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    rowsFromTiles(grid, cache, 1, new Uint8Array(70), 0, 7)
    expect(drawn).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0])
  })

  it('reads a window in one tile row as a view, and one across rows as a copy of each part', () => {
    const field = new Uint8Array(10 * 100).map((_, i) => i % 251)
    const cache = new TileRowCache(2, () => new Uint8Array(10 * 10), (ty, slot) => slot.set(field.subarray(ty * 100, ty * 100 + 100)))
    const span = new Uint8Array(10 * 20)
    const inOne = rowsFromTiles(grid, cache, 1, span, 12, 18)
    expect(inOne.buffer).not.toBe(span.buffer)
    expect([...inOne]).toEqual([...field.subarray(120, 180)])
    const across = rowsFromTiles(grid, cache, 1, span, 15, 32)
    expect(across.buffer).toBe(span.buffer)
    expect([...across]).toEqual([...field.subarray(150, 320)])
    expect(() => rowsFromTiles(grid, cache, 1, new Uint8Array(10), 15, 32)).toThrow(/rows \[15, 32\) do not fit the span of 1/)
  })

  it('a broken invariant is a plain Error, never the RangeError Save reads as memory running out', () => {
    const cache = new TileRowCache(2, () => new Uint8Array(10 * 10), () => {})
    const thrown = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        return e
      }
      return null
    }
    for (const [what, f] of [
      ['a span a row short', () => rowsFromTiles(grid, cache, 1, new Uint8Array(10 * 16), 15, 32)],
      ['rows past the sheet', () => rowsFromTiles(grid, cache, 1, new Uint8Array(10 * 20), 95, 101)],
      ['rows backwards', () => rowsFromTiles(grid, cache, 1, new Uint8Array(10 * 20), 20, 10)],
      ['no sheet', () => tileGrid(0, 10)],
      ['a ring of nothing', () => new TileRowCache(0, () => null, () => {})],
    ] as const) {
      const e = thrown(f)
      expect(e, what).toBeInstanceOf(Error)
      expect(e, what).not.toBeInstanceOf(RangeError)
    }
  })
})

describe('a photo at its own pixels', () => {
  it('is a rectangle the photo\'s size at a whole-pixel offset: the snapped native ground and a smaller copy decoded to its rectangle', () => {
    // 40 MP on 4:5, snapped (media.ts snapRect).
    const r = snapRect(coverRect({ width: 7728, height: 5152 }, areaOf(4122, 5152), { scale: 1, x: 0.5, y: 0.5 }), 7728, 5152, areaOf(4122, 5152))
    expect(isNativeRect(r, 7728, 5152)).toBe(true)
    expect(r).toEqual({ dx: -1803, dy: 0, dw: 7728, dh: 5152 })
    // A copy decoded to its (integer) rectangle, drawn 1:1.
    expect(isNativeRect({ dx: -1352, dy: 0, dw: 5796, dh: 3864 }, 5796, 3864)).toBe(true)
    // A zoomed photo at its native height is snapped too.
    const z = snapRect(coverRect({ width: 4032, height: 3024 }, areaOf(1209, 1512), { scale: 2, x: 0.3, y: 0.5 }), 4032, 3024, areaOf(1209, 1512))
    expect(isNativeRect(z, 4032, 3024)).toBe(true)
    // Not native: half a pixel off, a hair over 1:1, or a bitmap of another
    // size than the rectangle (the preview's working copy).
    expect(isNativeRect({ dx: -0.5, dy: 0, dw: 4032, dh: 3024 }, 4032, 3024)).toBe(false)
    expect(isNativeRect({ dx: 0, dy: 0, dw: 4034.016, dh: 3025.512 }, 4032, 3024)).toBe(false)
    expect(isNativeRect({ dx: 0, dy: 0, dw: 4032, dh: 3024 }, 2048, 1536)).toBe(false)
  })
})

/** A 2D context that records every call it is given, and measures text at
 *  0.6 em a glyph. */
function recorder() {
  const calls: string[] = []
  const fonts: string[] = []
  const ctx = {
    canvas: { width: 0, height: 0 },
    set font(f: string) {
      fonts.push(f)
      calls.push(`font ${f}`)
    },
    get font() {
      return fonts[fonts.length - 1] ?? ''
    },
    fillStyle: '',
    textBaseline: '',
    textAlign: '',
    letterSpacing: '',
    measureText: (t: string) => {
      const px = Number(/ ([\d.e+]+)px /.exec(fonts[fonts.length - 1] ?? '')?.[1])
      return { width: 0.6 * px * [...t].length }
    },
    clearRect: (...a: number[]) => calls.push(`clearRect ${a.join(',')}`),
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    translate: (x: number, y: number) => calls.push(`translate ${x},${y}`),
    rotate: (a: number) => calls.push(`rotate ${a}`),
    scale: (x: number, y: number) => calls.push(`scale ${x},${y}`),
    fillText: (t: string, x: number, y: number) => calls.push(`fillText ${t} ${x} ${y}`),
    fillRect: (...a: number[]) => calls.push(`fillRect ${a.join(',')}`),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, fonts }
}

const layer = (over: Partial<TextLayer> = {}): TextLayer => ({
  id: 'a',
  text: 'RISO\nPRINT',
  inkId: 'black',
  fontId: 'poster',
  bold: true,
  size: 0.09,
  lineHeight: 0.94,
  tracking: -0.02,
  contrastInkId: null,
  contrastThreshold: 0.5,
  align: 'center',
  x: 0.5,
  y: 0.5,
  rotation: -4,
  backing: 'yellow',
  ...over,
})

describe('glyphs on the tile grid', () => {
  it('every tile draws the same calls; only the first translate (the tile\'s origin) differs', () => {
    const l = layer()
    const grid = tileGrid(800, 1000, { edge: 512, pixels: 65536 })
    const { ctx, calls } = recorder()
    const plan = planGlyphs(ctx, l, grid.h)
    const tiles = Array.from({ length: grid.rows * grid.cols }, (_, k) => tileAt(grid, k % grid.cols, Math.floor(k / grid.cols)))
    const perTile = tiles.map((t) => {
      calls.length = 0
      drawGlyphs(ctx, plan, l, grid.w, grid.h, t)
      return calls.slice()
    })
    // Everything but the clear (the tile's size) and the first translate.
    const strip = (c: string[]) => c.filter((_, i) => i !== 0 && i !== 2)
    expect(perTile.length).toBe(16)
    for (const [k, c] of perTile.entries()) {
      const t = tiles[k]
      expect(c[0]).toBe(`clearRect 0,0,${t.w},${t.h}`)
      expect(c[2]).toBe(`translate ${-t.x0},${-t.y0}`)
      expect(strip(c)).toEqual(strip(perTile[0]))
    }
    // The backing the same way.
    calls.length = 0
    drawBacking(ctx, plan, l, grid.w, grid.h, tileAt(grid, 1, 3))
    expect(calls[2]).toBe('translate -512,-384')
    expect(calls.filter((c) => c.startsWith('fillRect')).length).toBe(2)
  })

  it('at or under the font cap, no scale call and the old coordinates; over it, the full-size layout drawn at fontSize / k under scale(k, k)', () => {
    // 0.09 of 1000: 90 px, far under the cap.
    const small = recorder()
    const plan = planGlyphs(small.ctx, layer(), 1000)
    expect(plan.k).toBe(1)
    drawGlyphs(small.ctx, plan, layer(), 800, 1000, { x0: 0, y0: 0, w: 800, h: 1000 })
    expect(small.calls.some((c) => c.startsWith('scale'))).toBe(false)
    const first = small.calls.find((c) => c.startsWith('fillText'))!
    const g = plan.layout.lines[0]
    const ox = plan.blockLeft + (plan.layout.widest - g.width) / 2
    expect(first).toBe(`fillText R ${ox + g.glyphs[0].x} ${plan.firstBaseline}`)

    // 120% on a 61 MP portrait on Original, 9504 tall: 11,404.8 px.
    const big = recorder()
    const l = layer({ size: 1.2 })
    const capped = planGlyphs(big.ctx, l, 9504)
    const k = 11404.8 / CANVAS_FONT_MAX
    expect(capped.fontSize).toBeCloseTo(11404.8, 9)
    expect(capped.k).toBeCloseTo(k, 12)
    expect(fontCapFactor(9216)).toBe(1)
    // The canvas never sees a font over the cap...
    expect(big.fonts.every((f) => Number(/ ([\d.e+]+)px /.exec(f)?.[1]) <= CANVAS_FONT_MAX + 1e-9)).toBe(true)
    // ...while the layout is the full size's: advances k times the capped
    // size's (0.6 em here), the line height and the backing at full size.
    const R = capped.layout.lines[0].glyphs[0]
    expect(R.width).toBeCloseTo(0.6 * 11404.8, 6)
    expect(capped.layout.lineHeight).toBeCloseTo(11404.8 * 0.94, 6)
    const rect = lineRects(capped.layout, l.align, capped.blockLeft, capped.firstBaseline)[0]
    expect(rect.h).toBeCloseTo(11404.8 * (0.58 + 0.32 + 2 * 0.12), 6)
    big.calls.length = 0
    drawGlyphs(big.ctx, capped, l, 6336, 9504, { x0: 0, y0: 0, w: 6336, h: 9504 })
    expect(big.calls).toContain(`scale ${capped.k},${capped.k}`)
    const drawn = big.calls.find((c) => c.startsWith('fillText'))!.split(' ').map(Number)
    const ox2 = capped.blockLeft + (capped.layout.widest - capped.layout.lines[0].width) / 2
    expect(drawn[2]).toBeCloseTo((ox2 + R.x) / capped.k, 9)
    expect(drawn[3]).toBeCloseTo(capped.firstBaseline / capped.k, 9)
    big.calls.length = 0
    drawBacking(big.ctx, capped, l, 6336, 9504, { x0: 0, y0: 0, w: 6336, h: 9504 })
    const fr = big.calls.find((c) => c.startsWith('fillRect'))!.split(' ')[1].split(',').map(Number)
    expect(fr[3] * capped.k).toBeCloseTo(rect.h, 6)
  })
})

/**
 * Tile sources whose loaders SLICE known whole fields: tile row ty of a
 * pass's ring is a copy, tile by tile, of the rows of its field; the
 * ground's the same of an RGBA field. The print fed these must be the print
 * fed the fields whole, byte for byte.
 */
function sliced(fields: Map<string, Uint8Array | Float32Array>, ground: Uint8ClampedArray | undefined, w: number, h: number, budget: { edge: number; pixels: number }, B: number) {
  const grid = tileGrid(w, h, budget)
  let loads = 0
  const tones = new TiledTones(grid, (pass: TonePass, ty, slot) => {
    loads++
    const f = fields.get(`${pass.kind}:${pass.layer.id}`)!
    for (let cx = 0; cx < grid.cols; cx++) {
      const t = tileAt(grid, cx, ty)
      for (let y = 0; y < t.h; y++) {
        for (let x = 0; x < t.w; x++) {
          const v = f[(t.y0 + y) * w + t.x0 + x]
          slot[y * w + t.x0 + x] = f instanceof Float32Array ? Math.round(v * 255) : v
        }
      }
    }
  })
  const rows = ground
    ? new TiledGroundRows(grid, B, (ty, slot) => {
        for (let cx = 0; cx < grid.cols; cx++) {
          const t = tileAt(grid, cx, ty)
          for (let y = 0; y < t.h; y++) slot.set(ground.subarray(((t.y0 + y) * w + t.x0) * 4, ((t.y0 + y) * w + t.x0 + t.w) * 4), (y * w + t.x0) * 4)
        }
      })
    : undefined
  return { tones, rows, loads: () => loads }
}

describe('the tile plumbing, exactly: tile sources that slice known fields print the fields whole', { timeout: 120_000 }, () => {
  const run = (name: string, w: number, h: number, budget: { edge: number; pixels: number }, bands: number[]) => {
    const { settings, ground: hasGround } = DOCS[name]
    const s: PrintSettings = JSON.parse(JSON.stringify(settings))
    const src = syntheticTones(name, w, h)
    const fields = new Map<string, Uint8Array | Float32Array>()
    for (const l of s.layers) {
      fields.set(`type:${l.id}`, (src.type(l) as { field: Uint8Array }).field)
      if (l.backing) fields.set(`backing:${l.id}`, (src.backing(l) as { field: Uint8Array }).field)
    }
    const whole: ToneSource = {
      type: (l) => ({ field: fields.get(`type:${l.id}`)!, fontSize: Math.max(1, l.size * h) }),
      backing: (l) => ({ field: fields.get(`backing:${l.id}`)!, fontSize: Math.max(1, l.size * h) }),
      size: (l) => Math.max(1, l.size * h),
    }
    const ground = hasGround ? makeGround(w, h, 5) : undefined
    const want = new Uint8ClampedArray(w * h * 4)
    printSheet(want, s, ground, whole, sampledNoise(s, w, h), w, h, { bandRows: h })
    for (const B of bands) {
      const t = sliced(fields, ground, w, h, budget, B)
      const out = new Uint8ClampedArray(w * h * 4)
      printSheet(out, s, t.rows, t.tones, sampledNoise(s, w, h), w, h, { bandRows: B })
      expect(sha(out), `${name} ${w}x${h}, tiles ${budget.edge}x${budget.pixels / budget.edge}, bands of ${B}`).toBe(sha(want))
      // The tile sources were read (the bytes above are theirs, not the
      // whole fields').
      expect(t.loads()).toBeGreaterThan(0)
    }
  }

  for (const name of Object.keys(DOCS)) {
    it(`${name}: 600x1000 on 512x128 tiles (2 x 8), bands of 7, 97 and the whole sheet`, () => {
      run(name, 600, 1000, { edge: 512, pixels: 65536 }, [7, 97, 1000])
    })
  }

  it('bands of one row on 64 x 32 tiles (switch-two, press-max: the widest halo)', () => {
    run('switch-two', 150, 260, { edge: 64, pixels: 2048 }, [1, 3])
    run('press-max', 150, 260, { edge: 64, pixels: 2048 }, [1, 5])
  })

  it('the real budget on a sheet over one tile (2100 x 2100: two tile rows), in its own bands', () => {
    run('backing', 2100, 2100, TILE_BUDGET, [bandHeight(2100, 2100)])
  })
})
