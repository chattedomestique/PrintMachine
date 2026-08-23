/**
 * Riso ink table.
 *
 * The RGB values are lifted verbatim from p5.riso's `RISOCOLORS`
 * (https://github.com/antiboredom/p5.riso, Sam Lavigne & Tega Brain), which
 * is the best-maintained transcription of Riso's published ink swatches. We
 * port the table rather than depend on the library: p5.riso isn't on npm and
 * requires all of p5.js, and the ink list is data, not code.
 *
 * These are the colour of the ink *as printed at full coverage on white*.
 * Everything downstream treats them as subtractive — see composite.ts.
 */

export interface Ink {
  /** Stable id, used in persisted settings. */
  readonly id: string
  /** Display name for the swatch picker. */
  readonly name: string
  readonly rgb: readonly [number, number, number]
}

const ink = (id: string, name: string, r: number, g: number, b: number): Ink => ({
  id,
  name,
  rgb: [r, g, b],
})

/**
 * Ordered so the picker opens on the inks people actually reach for. The
 * fluorescents are first because they are the reason to print Riso at all —
 * no other process can make that pink.
 */
export const RISO_INKS: readonly Ink[] = [
  ink('fluorescentpink', 'Fluoro Pink', 255, 72, 176),
  ink('blue', 'Blue', 0, 120, 191),
  ink('black', 'Black', 0, 0, 0),
  ink('yellow', 'Yellow', 255, 232, 0),
  ink('fluorescentorange', 'Fluoro Orange', 255, 116, 119),
  ink('brightred', 'Bright Red', 241, 80, 96),
  ink('green', 'Green', 0, 169, 92),
  ink('purple', 'Purple', 118, 91, 167),
  ink('teal', 'Teal', 0, 131, 138),
  ink('orange', 'Orange', 255, 108, 47),
  ink('mediumblue', 'Medium Blue', 50, 85, 164),
  ink('burgundy', 'Burgundy', 145, 78, 114),
  ink('federalblue', 'Federal Blue', 61, 85, 136),
  ink('flatgold', 'Flat Gold', 187, 139, 65),
  ink('huntergreen', 'Hunter Green', 64, 112, 96),
  ink('red', 'Red', 255, 102, 94),
  ink('brown', 'Brown', 146, 95, 82),
  ink('marinered', 'Marine Red', 210, 81, 94),
  ink('lightgray', 'Light Gray', 136, 137, 138),
  ink('metallicgold', 'Metallic Gold', 172, 147, 110),
  ink('crimson', 'Crimson', 228, 93, 80),
  ink('cornflower', 'Cornflower', 98, 168, 229),
  ink('skyblue', 'Sky Blue', 73, 130, 207),
  ink('seablue', 'Sea Blue', 0, 116, 162),
  ink('lake', 'Lake', 35, 91, 168),
  ink('indigo', 'Indigo', 72, 77, 122),
  ink('midnight', 'Midnight', 67, 80, 96),
  ink('mist', 'Mist', 213, 228, 192),
  ink('granite', 'Granite', 165, 170, 168),
  ink('charcoal', 'Charcoal', 112, 116, 124),
  ink('smokyteal', 'Smoky Teal', 95, 130, 137),
  ink('steel', 'Steel', 55, 94, 119),
  ink('slate', 'Slate', 94, 105, 94),
  ink('turquoise', 'Turquoise', 0, 170, 147),
  ink('emerald', 'Emerald', 25, 151, 93),
  ink('grass', 'Grass', 57, 126, 88),
  ink('forest', 'Forest', 81, 110, 90),
  ink('spruce', 'Spruce', 74, 99, 93),
  ink('moss', 'Moss', 104, 114, 77),
  ink('seafoam', 'Seafoam', 98, 194, 177),
  ink('kellygreen', 'Kelly Green', 103, 179, 70),
  ink('lightteal', 'Light Teal', 0, 157, 165),
  ink('ivy', 'Ivy', 22, 155, 98),
  ink('pine', 'Pine', 35, 126, 116),
  ink('lagoon', 'Lagoon', 47, 97, 101),
  ink('violet', 'Violet', 157, 122, 210),
  ink('orchid', 'Orchid', 170, 96, 191),
  ink('plum', 'Plum', 132, 89, 145),
  ink('raisin', 'Raisin', 119, 93, 122),
  ink('grape', 'Grape', 108, 93, 128),
  ink('scarlet', 'Scarlet', 246, 80, 88),
  ink('cranberry', 'Cranberry', 209, 81, 122),
  ink('maroon', 'Maroon', 158, 76, 110),
  ink('brick', 'Brick', 167, 81, 84),
  ink('lightlime', 'Light Lime', 227, 237, 85),
  ink('sunflower', 'Sunflower', 255, 181, 17),
  ink('melon', 'Melon', 255, 174, 59),
  ink('apricot', 'Apricot', 246, 160, 77),
  ink('paprika', 'Paprika', 238, 127, 75),
  ink('pumpkin', 'Pumpkin', 255, 111, 76),
  ink('brightolive', 'Bright Olive', 180, 159, 41),
  ink('brightgold', 'Bright Gold', 186, 128, 50),
  ink('copper', 'Copper', 189, 100, 57),
  ink('mahogany', 'Mahogany', 142, 89, 90),
  ink('bisque', 'Bisque', 242, 205, 207),
  ink('bubblegum', 'Bubblegum', 249, 132, 202),
  ink('lightmauve', 'Light Mauve', 230, 181, 201),
  ink('darkmauve', 'Dark Mauve', 189, 140, 166),
  ink('wine', 'Wine', 145, 78, 114),
  ink('gray', 'Gray', 146, 141, 136),
  ink('coral', 'Coral', 255, 142, 145),
  ink('aqua', 'Aqua', 94, 200, 229),
  ink('mint', 'Mint', 130, 216, 213),
  ink('fluorescentyellow', 'Fluoro Yellow', 255, 233, 22),
  ink('fluorescentred', 'Fluoro Red', 255, 76, 101),
  ink('fluorescentgreen', 'Fluoro Green', 68, 214, 44),
  ink('white', 'White', 255, 255, 255),
]

const BY_ID = new Map(RISO_INKS.map((i) => [i.id, i]))

/** Look up an ink by id, falling back to the first ink for unknown ids so a
 *  stale persisted setting can never crash the render. */
export function inkById(id: string): Ink {
  return BY_ID.get(id) ?? RISO_INKS[0]
}

export const cssRgb = (rgb: readonly [number, number, number]): string =>
  `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`

/**
 * Preview the colour of `top` overprinted on `bottom` at full coverage, using
 * the same subtractive model as the compositor. Used by the UI to show what a
 * two-ink pairing will actually produce.
 */
export function overprint(
  bottom: readonly [number, number, number],
  top: readonly [number, number, number],
): [number, number, number] {
  return [
    Math.round((bottom[0] * top[0]) / 255),
    Math.round((bottom[1] * top[1]) / 255),
    Math.round((bottom[2] * top[2]) / 255),
  ]
}

/** Common paper stocks. Riso is almost never printed on pure white. */
export interface Paper {
  readonly id: string
  readonly name: string
  readonly rgb: readonly [number, number, number]
}

export const PAPERS: readonly Paper[] = [
  { id: 'natural', name: 'Natural', rgb: [242, 239, 230] },
  { id: 'bright', name: 'Bright White', rgb: [250, 250, 248] },
  { id: 'cream', name: 'Cream', rgb: [243, 233, 210] },
  { id: 'newsprint', name: 'Newsprint', rgb: [231, 226, 209] },
  { id: 'kraft', name: 'Kraft', rgb: [204, 178, 141] },
  { id: 'french', name: 'French Grey', rgb: [214, 212, 205] },
  { id: 'blush', name: 'Blush', rgb: [242, 224, 218] },
]

const PAPER_BY_ID = new Map(PAPERS.map((p) => [p.id, p]))

export function paperById(id: string): Paper {
  return PAPER_BY_ID.get(id) ?? PAPERS[0]
}
