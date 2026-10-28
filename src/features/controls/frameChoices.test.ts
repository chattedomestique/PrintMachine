/**
 * The Frame tool's chips (frameChoices.ts): the ratio row reaches every sheet
 * shape the document can hold, a second tap flips (Original and 1:1 do not),
 * and Original needs a photo; the fill row shows the colour each fill draws.
 */

import { describe, expect, it } from 'vitest'
import { ASPECTS } from '../../engine/types.ts'
import { CHIP_RATIOS, flipOf, type AspectKey } from '../../engine/aspect.ts'
import { cssRgb, paperById, PAPERS } from '../../engine/inks.ts'
import { chipFace, chipName, chipTap } from '../../ui/chips.ts'
import { ASPECT_KEYS } from '../../state/fields.ts'
import { FILLS, FROSTED_ICON, fillChips, ratioChips } from './frameChoices.ts'

const PALETTE = { photo: '#3a6ea5', deep: '#141d26', muted: '#a8b4c0', comp: '#a5713a' }

describe('the ratio chips', () => {
  const chips = ratioChips(true)

  it('in Border Studio\'s order, Original first, and every shape the document can hold reachable', () => {
    expect(chips.map((c) => c.id)).toEqual(CHIP_RATIOS)
    expect(chips.map((c) => c.label)).toEqual(['Original', '1:1', '4:5', '3:4', '9:16', '2:3'])
    const reached = new Set(chips.flatMap((c) => [c.id, ...(c.alt ? [c.alt.id] : [])]))
    expect([...reached].sort()).toEqual([...ASPECT_KEYS].sort())
    expect(reached.size).toBe(Object.keys(ASPECTS).length + 1)
  })

  // The flip table: what a tap on each chip chooses, from each value.
  it('a second tap on the chosen chip flips it, and a third flips it back; Original and 1:1 stay', () => {
    const table = chips.map((c) => {
      const once = chipTap(c, c.id)
      const twice = once === null ? null : chipTap(c, once)
      return [c.id, once, twice]
    })
    expect(table).toEqual([
      ['original', null, null],
      ['1:1', null, null],
      ['4:5', '5:4', '4:5'],
      ['3:4', '4:3', '3:4'],
      ['9:16', '16:9', '9:16'],
      ['2:3', '3:2', '2:3'],
    ])
    for (const [id, once] of table) if (once !== null) expect(once).toBe(flipOf(id as AspectKey))
  })

  it('a tap on a chip that is not chosen chooses its first way round, whatever is chosen', () => {
    for (const from of ASPECT_KEYS) {
      for (const c of chips) {
        if (chipFace(c, from).pressed) continue
        expect(chipTap(c, from)).toBe(c.id)
      }
    }
  })

  it('the chosen landscape twin shows on its chip, pressed, with the flip cue', () => {
    const nine = chips.find((c) => c.id === '9:16')!
    expect(chipFace(nine, '16:9')).toEqual({ id: '16:9', label: '16:9', pressed: true, flips: true })
  })

  it('Original needs a photo (the sheet is the photo\'s own shape); every other ratio does not', () => {
    const bare = ratioChips(false)
    expect(bare.filter((c) => c.disabled).map((c) => c.id)).toEqual(['original'])
    expect(chipTap(bare[0], '4:5')).toBeNull()
    expect(chips.some((c) => c.disabled)).toBe(false)
  })
})

describe('the fill chips', () => {
  it('Paper, Photo, Deep, Muted, Comp and Frosted, each named', () => {
    expect(fillChips(PALETTE, 'natural', 'photo', false).map((c) => [c.id, c.label])).toEqual(FILLS.map((f) => [f.id, f.label]))
    expect(FILLS.map((f) => f.label)).toEqual(['Paper', 'Photo', 'Deep', 'Muted', 'Comp', 'Frosted'])
  })

  it('Paper is the stock, and follows it', () => {
    for (const p of PAPERS) expect(fillChips(PALETTE, p.id, 'photo', false)[0].swatch).toBe(cssRgb(p.rgb))
  })

  it('the photo\'s four colours are its palette\'s', () => {
    const [, photo, deep, muted, comp] = fillChips(PALETTE, 'natural', 'photo', false)
    expect([photo, deep, muted, comp].map((c) => c.swatch)).toEqual([PALETTE.photo, PALETTE.deep, PALETTE.muted, PALETTE.comp])
  })

  it('before the palette is made they show the stock, as the frame is drawn until then', () => {
    const stock = cssRgb(paperById('natural').rgb)
    expect(fillChips(undefined, 'natural', 'photo', false).slice(0, 5).map((c) => c.swatch)).toEqual([stock, stock, stock, stock, stock])
  })

  it('Frosted is a glyph, not a colour; no fill is disabled and none flips', () => {
    const chips = fillChips(PALETTE, 'natural', 'photo', false)
    expect(chips[5]).toEqual({ id: 'frosted', label: 'Frosted', icon: FROSTED_ICON })
    expect(chips.every((c) => !c.disabled && !c.alt)).toBe(true)
    for (const c of chips) expect(chipTap(c, c.id)).toBeNull()
  })

  it('while the chosen fill is being made its chip alone is busy, and says so; once made, none is', () => {
    for (const chosen of FILLS.map((f) => f.id)) {
      const chips = fillChips(undefined, 'natural', chosen, true)
      expect(chips.filter((c) => c.busy).map((c) => c.id)).toEqual([chosen])
      expect(chipName(chips.find((c) => c.id === chosen)!, chosen)).toBe(`${FILLS.find((f) => f.id === chosen)!.label}, preparing`)
      expect(fillChips(PALETTE, 'natural', chosen, false).some((c) => c.busy)).toBe(false)
    }
  })
})
