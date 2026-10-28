/**
 * The Frame tool's two rows of chips (FramePanel.tsx), and what each chip
 * shows: the sheet's ratio, and the frame's fill. Pure, so each rule has a
 * test (frameChoices.test.ts).
 */

import { CHIP_RATIOS, flipOf, type AspectKey } from '../../engine/aspect.ts'
import { cssRgb, paperById } from '../../engine/inks.ts'
import type { FillKey, FramePalette } from '../../engine/types.ts'
import type { ChipItem } from '../../ui/chips.ts'

/** Said under Crop | Fit on an Original sheet: the sheet is the photo's own
 *  shape and its border, so there is nothing to trim and nothing to mat. */
export const ORIGINAL_WHOLE = 'Original keeps the whole photo'

const ratioLabel = (key: AspectKey): string => (key === 'original' ? 'Original' : key)

/**
 * The ratio chips (Border Studio's, with its Free as Original): Original,
 * 1:1, then the portrait ratios, each reaching its landscape twin with a
 * second tap (`flipOf`); Original and 1:1 have no other way round. The ratio
 * is the sheet's, so it means as much on bare paper as under a photo, except
 * Original, the photo's own shape, which needs a photo.
 */
export function ratioChips(hasPhoto: boolean): ChipItem<AspectKey>[] {
  return CHIP_RATIOS.map((id) => {
    const twin = flipOf(id)
    return {
      id,
      label: ratioLabel(id),
      ...(twin !== id ? { alt: { id: twin, label: ratioLabel(twin) } } : {}),
      ...(id === 'original' && !hasPhoto ? { disabled: true } : {}),
    }
  })
}

/** The fills, in the order the row shows them: the stock, the photo's colour
 *  at three weights, the colour that stands off it, and the photo frosted. */
export const FILLS: readonly { id: FillKey; label: string }[] = [
  { id: 'paper', label: 'Paper' },
  { id: 'photo', label: 'Photo' },
  { id: 'deep', label: 'Deep' },
  { id: 'muted', label: 'Muted' },
  { id: 'comp', label: 'Comp' },
  { id: 'frosted', label: 'Frosted' },
]

/** Frosted's glyph: it is the photo blurred, not one colour. */
export const FROSTED_ICON = 'blend'

/**
 * The fill chips, each showing the colour the frame is drawn in when it is
 * chosen: Paper is the stock; Photo, Deep, Muted and Comp are the photo's
 * palette (`media.palette`), or the stock while it is still being made (the
 * frame is drawn as Paper until then, so the chip says what the sheet shows).
 * Frosted is a glyph: its field is made only once it is chosen, and it is
 * the photo itself, blurred, not a colour.
 *
 * `preparing`: the chosen fill is still being made from the photo (its
 * palette, or Frosted's source: frameInputs.ts `fillPreparing`), so its chip
 * is busy (a spinner in place of its dot or glyph) while the border is Paper.
 */
export function fillChips(palette: FramePalette | undefined, paperId: string, chosen: FillKey, preparing: boolean): ChipItem<FillKey>[] {
  const stock = cssRgb(paperById(paperId).rgb)
  return FILLS.map(({ id, label }) => {
    const face = id === 'frosted' ? { icon: FROSTED_ICON } : { swatch: id === 'paper' ? stock : (palette?.[id] ?? stock) }
    return { id, label, ...face, ...(preparing && id === chosen ? { busy: true } : {}) }
  })
}
