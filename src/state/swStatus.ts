/**
 * Service worker readiness, as something the UI can show.
 *
 * The problem this exists to solve: on iOS a home-screen PWA has to be
 * launched once *while online* before it will ever open offline. Nothing in a
 * page can force a service worker to install without a network, so the honest
 * fix is not to make offline work earlier — it is to stop the readiness state
 * being invisible. You should be able to tell the app is safe to take on a
 * plane before you are on the plane, rather than finding out at 30,000 feet.
 *
 * A tiny external store rather than Context: `registerSW` is called once at
 * module scope in main.tsx, long before React mounts, so the state has to live
 * outside the tree and be subscribed to.
 */

export type SWState = 'pending' | 'ready' | 'unsupported'

let state: SWState = 'pending'
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** Called by the SW registration when everything is precached. */
export function setOfflineReady(): void {
  if (state === 'ready') return
  state = 'ready'
  emit()
}

/** Called when there is no service worker to wait for. */
export function setUnsupported(): void {
  if (state !== 'pending') return
  state = 'unsupported'
  emit()
}

export function getSWState(): SWState {
  return state
}

export function subscribeSW(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
