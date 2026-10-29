/**
 * The bundled face, there before anything measures.
 *
 * Text is measured synchronously: the layout's advances (`canvasMeasure`),
 * Fit (`fitSize`), a tap on a plate (`hitLayer`), the normaliser's one-time
 * Fit conversion when a stored document is opened, and every glyph raster
 * the preview keeps. A canvas does not wait for a face: asked for one still
 * loading, it measures and draws in the fallback. So the face is loaded
 * first, once, in `main.tsx`, before the document is read or anything is
 * drawn (README "Fonts").
 *
 * The wait is raced against `FACE_WAIT_MS`: a face that fails or is slow
 * never leaves a blank app; the app goes on in the fallback stack (the rest
 * of Poster's stack, engine/types.ts). If the face lands after that, the
 * generation moves and the preview's glyph rasters, keyed by it (render.ts
 * `ensureCache`), are made again in the face, so a late face is never mixed
 * with rasters made without it. A face that failed outright stays failed
 * until the next launch: what was set in the fallback is what prints.
 */

/** The bundled face's family, as src/styles/fonts.css declares it. */
export const POSTER_FAMILY = 'Tanklager'

/** How long the first paint waits for the face before it goes on without it. */
export const FACE_WAIT_MS = 2000

/** What the first wait came to: the face is in; it is still on its way (the
 *  app goes on, and `faceGeneration` moves if it lands); it will not load. */
export type FaceOutcome = 'loaded' | 'late' | 'failed'

/** The part of `document.fonts` this uses (a test hands in its own). */
export interface FaceLoader {
  load(font: string): Promise<readonly { status: string }[]>
}

let generation = 0
const listeners = new Set<() => void>()

/** Moves each time a face lands after the app went on without it. */
export const faceGeneration = (): number => generation

/** Calls `fn` when the generation moves; returns the unsubscribe (the shape
 *  React's `useSyncExternalStore` takes). */
export function onFaceLanded(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Load the bundled face, waiting at most `wait` ms. Never rejects.
 *
 * `document.fonts.load` resolves with the faces that match: none when the
 * stylesheet declares no such face (which `document.fonts.check` would call
 * ready), so an empty answer is a failure, as is any face not `loaded`.
 */
export async function loadFaces(
  fonts: FaceLoader | undefined = globalThis.document?.fonts,
  wait: number = FACE_WAIT_MS,
): Promise<FaceOutcome> {
  if (!fonts) return 'failed'
  let request: Promise<readonly { status: string }[]>
  try {
    request = fonts.load(`40px ${POSTER_FAMILY}`)
  } catch {
    // An engine that throws where the spec rejects: the app still mounts.
    return 'failed'
  }
  const settled: Promise<'loaded' | 'failed'> = request.then(
    (faces) => (faces.length > 0 && faces.every((f) => f.status === 'loaded') ? 'loaded' : 'failed'),
    () => 'failed',
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), wait)
  })
  const first = await Promise.race([settled, late])
  clearTimeout(timer)
  if (first === 'late') {
    void settled.then((outcome) => {
      if (outcome !== 'loaded') return
      generation++
      for (const fn of listeners) fn()
    })
  }
  return first
}
