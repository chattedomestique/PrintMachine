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

/** Long edge an import is downscaled to before it is ever stored or drawn.
 *  A 12-megapixel phone photo decoded at full size is ~48 MB of RGBA, and two
 *  of those is the iOS eviction path the playbook §4.2 exists to avoid. 2048
 *  still exceeds the 1800px export height, so nothing visible is lost. */
export const MAX_EDGE = 2048

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

/** Ids still held, so an import can sweep the ones no document references. */
export function listMedia(): Promise<string[]> {
  return tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.filter((k): k is string => typeof k === 'string'),
  )
}
