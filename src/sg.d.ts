/**
 * The style guide's layout scripts (public/sg, loaded as plain deferred
 * scripts by index.html, not bundled): the little of window.SG this app calls.
 * Optional throughout, because they load after the module and may be absent.
 */
interface Window {
  SG?: {
    /** Measures a bar and writes the richest layout that fits to data-fit. */
    fit?: {
      register: (selector: string, options: { steps: string[]; parts?: string; strict?: boolean }) => void
      /** Re-check everything now. */
      update?: () => void
    }
    /** Roving focus, and paging whole tools when they cannot all fit: the hook
     *  for a toolbar added after the page loaded. */
    toolbar?: {
      init: (list: Element) => void
    }
  }
}
