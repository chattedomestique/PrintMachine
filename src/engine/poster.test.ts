/**
 * Poster is one face of one weight, and the preview's glyph rasters are
 * keyed by the face generation (features/media/faces.ts).
 *
 * The press runs here on 2D contexts that record what they are asked to set
 * and draw (every font, every glyph and where it goes, every row put on the
 * sheet), and measure an advance by the font they are set in: a bold that
 * reached the canvas would change both the font and every glyph's place.
 */

import { describe, expect, it } from 'vitest'
import { cssFont, layerFont } from './text.ts'
import { FONTS, fontById, type PrintSettings, type TextLayer } from './types.ts'
import { renderPrint, renderPrintAsync, type RenderCache } from './render.ts'
import { defaultSettings } from '../state/defaults.ts'

/** A context that logs what it is set and asked to draw. An advance is 10 px
 *  a character at 400 and 12 at 700, so a weight that reaches the canvas moves
 *  every glyph after the first. Anything else it is asked is a no-op. */
function recording(log: string[]) {
  let font = ''
  const known = {
    canvas: { width: 0, height: 0 },
    get font() {
      return font
    },
    set font(v: string) {
      font = v
      log.push(`font ${v}`)
    },
    fillText: (t: string, x: number, y: number) => void log.push(`glyph ${t} ${x.toFixed(3)} ${y.toFixed(3)}`),
    measureText: (t: string) => ({ width: [...t].length * (font.startsWith('700') ? 12 : 10) }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img: { data: Uint8ClampedArray }, _x: number, y: number) => {
      let sum = 0
      for (let i = 0; i < img.data.length; i++) sum = (sum * 31 + img.data[i]) >>> 0
      log.push(`put ${y} ${sum}`)
    },
  }
  const ctx = new Proxy(known as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => {
      t[k] = v
      return true
    },
  })
  return ctx as unknown as CanvasRenderingContext2D
}

const withPlates = (fontId: TextLayer['fontId'], bold: boolean): PrintSettings => {
  const s = defaultSettings()
  return { ...s, layers: s.layers.map((l) => ({ ...l, fontId, bold })) }
}

/** What the preview and the export ask of their canvases, for a document. */
async function pressLog(s: PrintSettings, height: number) {
  const preview: string[] = []
  renderPrint(recording(preview), recording(preview), s, { current: null }, null, height, null, {})
  const exported: string[] = []
  await renderPrintAsync(recording(exported), recording(exported), s, height, null, {})
  return { preview, exported }
}

describe('Poster is one weight', () => {
  it("its stack leads with the bundled face; the faces that have a bold are the system stacks", () => {
    expect(fontById('poster').stack.startsWith('Tanklager, ')).toBe(true)
    expect(FONTS.filter((f) => !f.bold).map((f) => f.id)).toEqual(['poster'])
  })

  it('a Poster plate is set at 400 whatever its Bold says; the other faces still set 700', () => {
    const layer = (fontId: TextLayer['fontId'], bold: boolean) => ({ ...defaultSettings().layers[0], fontId, bold })
    expect(cssFont(layerFont(layer('poster', true), 40))).toBe(`400 40px ${fontById('poster').stack}`)
    expect(cssFont(layerFont(layer('poster', false), 40))).toBe(`400 40px ${fontById('poster').stack}`)
    for (const id of ['grotesk', 'serif', 'mono'] as const) {
      expect(layerFont(layer(id, true), 40).weight).toBe(700)
      expect(layerFont(layer(id, false), 40).weight).toBe(400)
    }
  })

  it('a Poster plate with Bold on presses exactly as with Bold off, in the preview and the export', async () => {
    const on = await pressLog(withPlates('poster', true), 300)
    const off = await pressLog(withPlates('poster', false), 300)
    expect(on.preview.some((e) => e.startsWith('glyph '))).toBe(true)
    expect(on.preview).toEqual(off.preview)
    expect(on.exported).toEqual(off.exported)
    expect(on.preview.filter((e) => e.startsWith('font ')).every((e) => e.startsWith('font 400 '))).toBe(true)
  })

  it('the same comparison sees a bold where a face has one (the control)', async () => {
    const on = await pressLog(withPlates('grotesk', true), 300)
    const off = await pressLog(withPlates('grotesk', false), 300)
    expect(on.preview).not.toEqual(off.preview)
    expect(on.exported).not.toEqual(off.exported)
  })
})

describe('the preview keeps its glyph rasters by face generation', () => {
  it('kept while the generation holds, made again when a face lands', () => {
    const s = defaultSettings()
    const cacheRef: { current: RenderCache | null } = { current: null }
    const render = (faces: number) => {
      const log: string[] = []
      renderPrint(recording(log), recording(log), s, cacheRef, null, 300, null, {}, { faces })
      return log.filter((e) => e.startsWith('glyph ')).length
    }
    expect(render(0)).toBeGreaterThan(0)
    const first = cacheRef.current
    // The same generation: the cache and its rasters are reused, no glyph is drawn.
    expect(render(0)).toBe(0)
    expect(cacheRef.current).toBe(first)
    // A face landed: everything made from the old face is made again.
    expect(render(1)).toBeGreaterThan(0)
    expect(cacheRef.current).not.toBe(first)
    expect(render(1)).toBe(0)
  }, 30_000)
})
