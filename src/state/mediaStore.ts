/**
 * Where the photo bytes live.
 *
 * Not localStorage. Its quota is around 5 MB of *string*, and base64 inflates
 * binary by a third — one phone photo would blow it, and the failure mode is a
 * throw that takes the whole save with it. IndexedDB stores the Blob directly,
 * with no encoding step and a quota measured in hundreds of megabytes.
 *
 * The document in localStorage keeps only the media id and its placement, so
 * the two stores can be written independently and a torn write costs a photo
 * rather than the whole print.
 */

const DB = 'printmachine'
const STORE = 'media'
const VERSION = 1

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('Media store failed'))
        t.oncomplete = () => db.close()
      }),
  )
}

export function putMedia(id: string, blob: Blob): Promise<void> {
  return tx('readwrite', (s) => s.put(blob, id)).then(() => undefined)
}

export function getMedia(id: string): Promise<Blob | null> {
  return tx<Blob | undefined>('readonly', (s) => s.get(id)).then((b) => b ?? null)
}

export function deleteMedia(id: string): Promise<void> {
  return tx('readwrite', (s) => s.delete(id)).then(() => undefined)
}

/** Every id the store holds, for the launch sweep. */
export function listMedia(): Promise<string[]> {
  return tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.filter((k): k is string => typeof k === 'string'),
  )
}

/** How old an unreferenced photo must be before the sweep may take it. */
export const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000

/** When a photo was imported, read back from its id (`media-<ms base 36>-<n>`,
 *  importMedia.ts), or null for an id in any other shape. */
export function mediaCreatedAt(id: string): number | null {
  const m = /^media-([0-9a-z]+)-\d+$/.exec(id)
  if (!m) return null
  const t = parseInt(m[1], 36)
  return Number.isFinite(t) ? t : null
}

export interface SweepStore {
  list: () => Promise<string[]>
  remove: (id: string) => Promise<void>
}

/**
 * Delete the stored photos nothing can reach any more. Run once, at launch.
 *
 * Remove and Replace do NOT delete a photo's bytes: an undo step can still
 * bring the old photo back, and deleting the bytes under it would leave the
 * document pointing at nothing. History is not persisted, so at launch only
 * the saved document can reference a photo, and anything else is garbage —
 * with two guards, both needed:
 *
 *  1. `referenced` is a SNAPSHOT of the document as it was loaded, taken
 *     before any edit, so an edit racing the sweep cannot widen what it takes.
 *  2. Only photos imported more than SWEEP_AFTER_MS ago go. Without this, an
 *     import that lands while the sweep is listing, or another tab's import
 *     already in IndexedDB but not yet saved to its document, would be
 *     deleted from under a live print. An id that does not parse counts as
 *     old: no build wrote one.
 *
 * Storage is therefore bounded by a day's worth of replaced photos.
 * @returns the ids it deleted.
 */
export async function sweepMedia(
  referenced: ReadonlySet<string>,
  store: SweepStore = { list: listMedia, remove: deleteMedia },
  now: number = Date.now(),
): Promise<string[]> {
  const gone: string[] = []
  for (const id of await store.list()) {
    if (referenced.has(id)) continue
    const created = mediaCreatedAt(id)
    if (created !== null && now - created <= SWEEP_AFTER_MS) continue
    await store.remove(id)
    gone.push(id)
  }
  return gone
}
