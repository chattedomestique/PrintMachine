/**
 * The export's measurement cases, shared by measure-alloc.mjs
 * (deterministic typed-array accounting, node) and measure-export.mjs (time
 * and resident memory in Chromium). Built from the app's own defaults, which
 * the caller loads and hands in.
 *
 * The documents of every size a phone saved before the band engine:
 *
 *  1. the default document with a 12 MP portrait photo, 4:5, second ink on:
 *     3024x3780 (11.4 MP);
 *  2. the worst LEGAL document (3 plates, 4 passes, two second inks) at
 *     4096x4096 (16.8 MP);
 *  3. no photo, the default document, at 3600 tall (2880x3600);
 *  4. Grain at 4096x4096;
 *  5. a legacy over-budget document (5 plates, 2 backings) at 4096x4096:
 *     recorded, not gated.
 *
 * Gated per output pixel (`gate`, B/px of typed arrays: what they measured
 * once Save pressed into the encoder, 7.29 / 6.26 / 6.41 / 5.06, x 1.25).
 *
 * The sizes the band engine made possible, each a photo at its own pixels:
 *
 *  6. 40 MP: 7728x5152 Original, the default document, second ink on;
 *  7. 61 MP: a 9504x6336 photo on 4:5 (5069x6336), the worst legal document
 *     (case 2's), halftone; 7g, the same in grain;
 *  8. 61 MP: 9504x6336 Original, case 2's document with the worst legal
 *     press (grain at pitch 36, misregistration 30) and every plate's type at
 *     0.16 of the height: the widest halo there is;
 *  9. a 48 MP 3:1 panorama, 12000x4000 Original, the default document with a
 *     second ink (three tile columns);
 * 10. 3:1, 6399x2133 Original, type at SIZE_MIN (0.01), second ink on: the
 *     luminance at one cell a pixel, two sheet-sized float arrays in the
 *     pre-pass and one through the press.
 *
 * Gated in megabytes (`gate.typed`, and `gate.total` with the canvases, the
 * decoded photo and the file at measure-alloc's FILE_BOUND added): the
 * ceilings the band engine was designed to, or what was measured x 1.25
 * where that is lower (case 7: 115.2 MB typed, so 144).
 *
 * Framed, each a photo at its own pixels inside its frame (the first
 * photo's width, 1/14 of the sheet's long side, or the widest, 0.16; round
 * corners; the photo's own colour):
 *
 * 11. 40 MP, 7728x5152 Original, the default document: 9016x6440 (58.1 MP);
 * 12. the same photo on 1:1 Fit: 9016x9016 (81.3 MP);
 * 13. 61 MP, 9504x6336 Original at the widest frame: 13976x10808 (151 MP);
 * 14. the owner's 40 MP portrait, 5152x7728, on 16:9 Fit: 18414x10358
 *     (191 MP, 4.8x the photo, the worst realistic default);
 * 15. the same at the widest frame: 31864x17924 (571 MP), memory only;
 * 16. case 11 in Frosted at its heaviest blur (240): 9016x6440, 18 MP of
 *     border sampled from the field twice (the second ink's luminance and
 *     the press), the photo's frame source and the field held through it.
 * 13 to 16 run with FULL=1.
 *
 * Gated in megabytes like 6 to 10, at what they measured x 1.25, and under
 * a stated CEILING that does not come from their own measurement (a gate
 * that is only "measured x 1.25" cannot fail on the day it is set): the
 * press holds what grows with the sheet's WIDTH, so the ceiling scales case
 * 6's measured typed peak by the width and adds what does not (the decoded
 * photo, the file at FILE_BOUND), with 30% to spare:
 * `ceiling = 1.30 x (CASE6.typed x W / CASE6.width + P + FILE_BOUND x pixels)`
 * (`ceiling` below). Where measured x 1.25 is over the ceiling, the gate is
 * the ceiling. And 11 and 12's typed arrays at most 1.30 x case 6's typed
 * gate (125 MB): 162.5 MB. Measured when the frame went in (typed / whole,
 * ceiling): 11, 118.0 / 379.1 MB (467.9); 12, 120.1 / 413.8 (510.1); 13,
 * 147.5 / 619.1 (828.6); 14, 168.7 / 613.6 (871.1); 15, 262.2 / 1238.8
 * (1794.8); and when Frosted's field went in, 16, 123.1 / 384.2 (467.9):
 * 5.1 MB more than case 11 (the frame source and the field, held through
 * the press). The typed arrays grow far slower than the width: a band is
 * BAND_PIXELS over the width, so a wider sheet presses fewer rows at a time.
 *
 * And the same-width pairs (`pair`): a 4000x10000 photo on Original (a
 * 4000x10000 sheet: the whole photo, at its own pixels) against a 4000x5000
 * one, for case 2's document and for its worst-press variant; and framed, a
 * 3618x6284 photo on Original (a 4666x7332 sheet) against a 4000x3000 one
 * (4666x3666), case 2's document with the first photo's frame. The press
 * holds what grows with the sheet's width, not its height, so the taller
 * one's peak typed bytes may be at most 1.15 times the shorter's.
 */

/** Case 6's typed-array peak as measured (MB) and its sheet's width: the
 *  base of every framed case's ceiling. measure-alloc checks it against
 *  case 6 whenever both run. */
export const CASE6 = { typed: 102.3, width: 7728 }

/** A framed case's ceiling, in MB, for a W-wide sheet of `pixels` holding a
 *  decoded photo of `photoBytes`, the file at `fileBound` bytes a pixel. */
export const ceiling = (W, photoBytes, pixels, fileBound) => 1.3 * ((CASE6.typed * 1e6 * W) / CASE6.width + photoBytes + fileBound * pixels) / 1e6

export function exportCases({ defaultSettings, makeLayer, makeMedia, contrastPartner, limits }) {
  const secondInk = (l) => ({ ...l, contrastInkId: contrastPartner(l.inkId) })
  const photoDoc = (w, h, aspect, layers) => {
    const s = defaultSettings()
    s.aspect = aspect
    s.media = makeMedia({ id: 'photo', width: w, height: h, native: true })
    if (layers) s.layers = layers
    return s
  }
  /** The default document with every plate's second ink on. */
  const defaultDoc = (w, h, aspect, size) => {
    const s = photoDoc(w, h, aspect)
    s.layers = s.layers.map((l) => secondInk(size === undefined ? l : { ...l, size }))
    return s
  }
  /** Case 2's document: 3 plates, 4 passes, two second inks; `size` sets
   *  every plate's type. */
  const case2Doc = (w, h, aspect, size) =>
    photoDoc(w, h, aspect, [
      secondInk(makeLayer({ size: size ?? 0.09 })),
      secondInk(makeLayer({ text: 'RISO', inkId: 'blue', size: size ?? 0.06, y: 0.76, rotation: -4 })),
      makeLayer({ text: 'TYPE ON A PHOTO', inkId: 'black', size: size ?? 0.03, y: 0.2, backing: 'yellow' }),
    ])
  /** The first photo's frame: its width (or `over`'s), round corners, the
   *  photo's own colour from the palette stored with it. */
  const framed = (s, over = {}) => {
    s.frame = { ...s.frame, width: limits.FRAME_WIDTH_FIRST, corners: 1, fill: 'photo', ...over }
    s.media = { ...s.media, palette: { photo: '#2896c8', deep: '#152228', muted: '#90b1c1', comp: '#cb712e' } }
    return s
  }
  /** The worst legal press: grain at its coarsest pitch, misregistration at
   *  its most, type at 0.16 of the height. */
  const worstPress = (s) => {
    s.press = { ...s.press, method: 'grain', screenPitch: 36, misregistration: 30 }
    return s
  }
  return [
    {
      id: '1',
      name: 'default document, 12 MP portrait photo, 4:5, second ink on',
      gate: 9.1,
      doc: () => defaultDoc(3024, 4032, '4:5'),
    },
    {
      id: '2',
      name: 'worst legal document: 3 plates, 4 passes, two second inks, 4096x4096',
      gate: 7.8,
      doc: () => case2Doc(4096, 4096, '1:1'),
    },
    { id: '3', name: 'no photo, default document (3600 tall)', gate: 8.0, doc: () => defaultSettings() },
    {
      id: '4',
      name: 'grain, 4096x4096, second ink on',
      gate: 6.3,
      doc: () => {
        const s = defaultDoc(4096, 4096, '1:1')
        s.press = { ...s.press, method: 'grain' }
        return s
      },
    },
    {
      id: '5',
      name: 'legacy over-budget document: 5 plates, 2 backings, 4096x4096 (recorded, not gated)',
      doc: () =>
        photoDoc(4096, 4096, '1:1', [
          secondInk(makeLayer({ size: 0.09 })),
          makeLayer({ text: 'RISO', inkId: 'blue', size: 0.06, y: 0.76, rotation: -4, backing: 'yellow' }),
          makeLayer({ text: 'ONE', size: 0.05, y: 0.15, backing: 'blue' }),
          secondInk(makeLayer({ text: 'TWO', inkId: 'black', size: 0.04, y: 0.3 })),
          secondInk(makeLayer({ text: 'THREE', inkId: 'teal', size: 0.03, y: 0.88 })),
        ]),
    },
    {
      id: '6',
      name: '40 MP, 7728x5152 Original, default document, second ink on',
      gate: { typed: 125, total: 350 },
      doc: () => defaultDoc(7728, 5152, 'original'),
    },
    {
      id: '7',
      name: "61 MP photo on 4:5 (5069x6336), case 2's document, halftone",
      gate: { typed: 144, total: 450 },
      doc: () => case2Doc(9504, 6336, '4:5'),
    },
    {
      id: '7g',
      name: "61 MP photo on 4:5 (5069x6336), case 2's document, grain",
      gate: { typed: 145, total: 450 },
      doc: () => {
        const s = case2Doc(9504, 6336, '4:5')
        s.press = { ...s.press, method: 'grain' }
        return s
      },
    },
    {
      id: '8',
      name: "61 MP, 9504x6336 Original, case 2's document, worst press (grain 36, misregistration 30, type 0.16)",
      gate: { typed: 210, total: 540 },
      full: true,
      doc: () => worstPress(case2Doc(9504, 6336, 'original', 0.16)),
    },
    {
      id: '9',
      name: '48 MP 3:1 panorama, 12000x4000 Original, default document, second ink on',
      gate: { typed: 150, total: 420 },
      doc: () => defaultDoc(12000, 4000, 'original'),
    },
    {
      id: '10',
      name: '3:1, 6399x2133 Original, type at SIZE_MIN (0.01), second ink on',
      gate: { typed: 185, total: 290 },
      doc: () => defaultDoc(6399, 2133, 'original', 0.01),
    },
    {
      id: '11',
      name: "40 MP, 7728x5152 Original, default document, the first photo's frame",
      gate: { typed: 147.5, total: 467 },
      ceiling: true,
      doc: () => framed(defaultDoc(7728, 5152, 'original')),
    },
    {
      id: '12',
      name: "40 MP, 7728x5152 on 1:1 Fit, default document, the first photo's frame",
      gate: { typed: 150, total: 510 },
      ceiling: true,
      doc: () => framed(defaultDoc(7728, 5152, '1:1'), { mode: 'fit' }),
    },
    {
      id: '13',
      name: '61 MP, 9504x6336 Original, default document, the widest frame',
      gate: { typed: 184, total: 773 },
      ceiling: true,
      full: true,
      doc: () => framed(defaultDoc(9504, 6336, 'original'), { width: limits.FRAME_WIDTH_MAX }),
    },
    {
      id: '14',
      name: "the owner's 40 MP portrait, 5152x7728 on 16:9 Fit, default document, the first photo's frame",
      gate: { typed: 210, total: 767 },
      ceiling: true,
      full: true,
      doc: () => framed(defaultDoc(5152, 7728, '16:9'), { mode: 'fit' }),
    },
    {
      id: '16',
      name: '40 MP, 7728x5152 Original, default document, the first photo\'s frame in Frosted at Blur 240',
      gate: { typed: 154, total: 467 },
      ceiling: true,
      full: true,
      doc: () => framed(defaultDoc(7728, 5152, 'original'), { fill: 'frosted', blur: 240 }),
    },
    {
      id: '15',
      name: "the same portrait on 16:9 Fit, the widest frame (memory only)",
      gate: { typed: 327, total: 1548 },
      ceiling: true,
      full: true,
      doc: () => framed(defaultDoc(5152, 7728, '16:9'), { mode: 'fit', width: limits.FRAME_WIDTH_MAX }),
    },
    { id: 'w2a', name: "same width: a 4000x5000 photo on Original, case 2's document", pair: 'w2', doc: () => case2Doc(4000, 5000, 'original') },
    { id: 'w2b', name: "same width: a 4000x10000 photo on Original, case 2's document", pair: 'w2', doc: () => case2Doc(4000, 10000, 'original') },
    { id: 'w8a', name: "same width: a 4000x5000 photo on Original, case 2's document, worst press", pair: 'w8', doc: () => worstPress(case2Doc(4000, 5000, 'original', 0.16)) },
    { id: 'w8b', name: "same width: a 4000x10000 photo on Original, case 2's document, worst press", pair: 'w8', doc: () => worstPress(case2Doc(4000, 10000, 'original', 0.16)) },
    { id: 'wfa', name: "same width, framed: a 4000x3000 photo on Original (4666x3666), case 2's document", pair: 'wf', doc: () => framed(case2Doc(4000, 3000, 'original')) },
    { id: 'wfb', name: "same width, framed: a 3618x6284 photo on Original (4666x7332), case 2's document", pair: 'wf', doc: () => framed(case2Doc(3618, 6284, 'original')) },
  ]
}
