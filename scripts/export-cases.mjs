/**
 * The export's measurement cases, shared by measure-alloc.mjs
 * (deterministic typed-array accounting, node) and measure-export.mjs (time
 * and resident memory in Chromium). Built from the app's own defaults, which
 * the caller loads and hands in.
 *
 *  1. the default document with a 12 MP portrait photo, 4:5, second ink on:
 *     3024x3780 (11.4 MP);
 *  2. the worst LEGAL document (3 plates, 4 passes, two second inks) at
 *     4096x4096 (16.8 MP);
 *  3. no photo, the default document, at 3600 tall (2880x3600);
 *  4. Grain at 4096x4096;
 *  5. a legacy over-budget document (5 plates, 2 backings) at 4096x4096:
 *     recorded, not gated.
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
  return [
    {
      id: 1,
      name: 'default document, 12 MP portrait photo, 4:5, second ink on',
      gated: true,
      doc: () => {
        const s = photoDoc(3024, 4032, '4:5')
        s.layers = s.layers.map(secondInk)
        return s
      },
    },
    {
      id: 2,
      name: 'worst legal document: 3 plates, 4 passes, two second inks, 4096x4096',
      gated: true,
      doc: () =>
        photoDoc(4096, 4096, '1:1', [
          secondInk(makeLayer({ size: 0.09 })),
          secondInk(makeLayer({ text: 'RISO', inkId: 'blue', size: 0.06, y: 0.76, rotation: -4 })),
          makeLayer({ text: 'TYPE ON A PHOTO', inkId: 'black', size: 0.03, y: 0.2, backing: 'yellow' }),
        ]),
    },
    { id: 3, name: 'no photo, default document (3600 tall)', gated: true, doc: () => defaultSettings() },
    {
      id: 4,
      name: 'grain, 4096x4096, second ink on',
      gated: true,
      doc: () => {
        const s = photoDoc(4096, 4096, '1:1')
        s.layers = s.layers.map(secondInk)
        s.press = { ...s.press, method: 'grain' }
        return s
      },
    },
    {
      id: 5,
      name: 'legacy over-budget document: 5 plates, 2 backings, 4096x4096 (recorded, not gated)',
      gated: false,
      doc: () =>
        photoDoc(4096, 4096, '1:1', [
          secondInk(makeLayer({ size: 0.09 })),
          makeLayer({ text: 'RISO', inkId: 'blue', size: 0.06, y: 0.76, rotation: -4, backing: 'yellow' }),
          makeLayer({ text: 'ONE', size: 0.05, y: 0.15, backing: 'blue' }),
          secondInk(makeLayer({ text: 'TWO', inkId: 'black', size: 0.04, y: 0.3 })),
          secondInk(makeLayer({ text: 'THREE', inkId: 'teal', size: 0.03, y: 0.88 })),
        ]),
    },
  ]
}
