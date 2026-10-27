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
 * And the same-width pairs (`pair`): a 4000x10000 photo on Original (a
 * 4000x10000 sheet: the whole photo, at its own pixels) against a 4000x5000
 * one, for case 2's document and for its worst-press variant. The
 * press holds what grows with the sheet's width, not its height, so the
 * taller one's peak typed bytes may be at most 1.15 times the shorter's.
 */
export function exportCases({ defaultSettings, makeLayer, makeMedia, contrastPartner }) {
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
    { id: 'w2a', name: "same width: a 4000x5000 photo on Original, case 2's document", pair: 'w2', doc: () => case2Doc(4000, 5000, 'original') },
    { id: 'w2b', name: "same width: a 4000x10000 photo on Original, case 2's document", pair: 'w2', doc: () => case2Doc(4000, 10000, 'original') },
    { id: 'w8a', name: "same width: a 4000x5000 photo on Original, case 2's document, worst press", pair: 'w8', doc: () => worstPress(case2Doc(4000, 5000, 'original', 0.16)) },
    { id: 'w8b', name: "same width: a 4000x10000 photo on Original, case 2's document, worst press", pair: 'w8', doc: () => worstPress(case2Doc(4000, 10000, 'original', 0.16)) },
  ]
}
