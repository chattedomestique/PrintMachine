/**
 * The browser's half of the face gate (verify-offline.mjs step 5), in a
 * module of its own so that a vitest control (src/features/media/faces.test.ts)
 * can show its verdicts fail where they must.
 *
 * Node cannot read Tanklager's outlines (they are CFF, and there is no CFF
 * reader here), and check-fonts.mjs's static rule cannot tell a lowercase
 * drawn as capitals from a real one: Railroad Gothic maps its lowercase to
 * glyphs of their own, and its `o` is as tall as its `O`. So the lowercase is
 * measured where the face is drawn, in the browser, from its ink.
 */

/** The family src/styles/fonts.css declares (features/media/faces.ts POSTER_FAMILY). */
export const POSTER_FAMILY = 'Tanklager'

/** How long the app waits for the face before it mounts without it
 *  (features/media/faces.ts FACE_WAIT_MS; faces.test.ts holds the two together). */
export const FACE_WAIT_MS = 2000

/** Poster's stack after its bundled face: what a page that cannot load the face
 *  sets Poster in. engine/types.ts's stack is this with the family in front
 *  (faces.test.ts holds the two together). */
export const POSTER_FALLBACK = `Impact, Haettenschweiler, 'Arial Narrow Bold', 'Helvetica Neue', sans-serif`

/** A face's lowercase is its own when the ink of `o` rises at most this far
 *  against `O`'s (Tanklager Kompakt measures 0.68; a face whose lowercase is
 *  its capitals measures 1). */
export const LOWERCASE_MAX = 0.9

/**
 * Runs in the page (handed to `page.evaluate`, so it uses nothing from here):
 * for each font, once `document.fonts.load` has settled for it (a canvas does
 * not wait for a face, so a measure taken while one is loading is the
 * fallback's), the ink ascent of each character
 * (`measureText().actualBoundingBoxAscent`) and the advance of `text`.
 */
export async function measureFaces({ fonts, chars, text }) {
  const ctx = document.createElement('canvas').getContext('2d')
  const out = []
  for (const font of fonts) {
    await document.fonts.load(font, text + chars.join('')).catch(() => [])
    ctx.font = font
    const ascents = {}
    for (const ch of chars) ascents[ch] = ctx.measureText(ch).actualBoundingBoxAscent
    out.push({ font, set: ctx.font, ascents, advance: ctx.measureText(text).width })
  }
  return out
}

/**
 * Whether a face draws a lowercase of its own, from its ink: `ascent(ch)` is
 * the measured ink ascent of a character (injected, so a test feeds it the
 * heights of a face it does not have).
 */
export function lowercaseVerdict(ascent) {
  const lower = ascent('o')
  const upper = ascent('O')
  const ratio = lower / upper
  return { ratio, ok: upper > 0 && lower > 0 && ratio <= LOWERCASE_MAX }
}

/** Whether the face is what sets the stack: a string's advance with the face
 *  leading the stack differs from its advance in the stack without it (equal
 *  when the face never loaded, and the stack fell through to the rest). */
export function faceSetsStack(withFace, without) {
  return Number.isFinite(withFace) && Number.isFinite(without) && Math.abs(withFace - without) > 0.5
}
