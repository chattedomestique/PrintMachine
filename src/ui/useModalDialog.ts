import { useEffect, useRef, type RefObject } from 'react'

/**
 * Open a native <dialog> modally while `open` is true (Border Studio's hook,
 * typed). The browser then makes the page inert, traps Tab, draws ::backdrop
 * and closes on Esc — so none of that is faked here. A tap on the backdrop
 * closes it too (a tap outside the card lands on the <dialog> element itself).
 *
 * Focus goes back to whatever opened the dialog, however it ends — closed, or
 * unmounted. The browser only does that for a dialog that is closed, and most
 * of these unmount, so the hook does it. The opener is recorded BEFORE
 * showModal() moves focus into the dialog; recorded after, it is the dialog.
 */
export function useModalDialog(open: boolean, onClose: () => void): RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement | null>(null)
  const closeRef = useRef(onClose)
  const openerRef = useRef<Element | null>(null)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      openerRef.current = document.activeElement
      d.showModal()
    }
    if (!open && d.open) d.close()
  }, [open])

  useEffect(() => {
    const d = ref.current
    if (!d) return
    // 'cancel' is Esc. Prevent the browser's own close so React stays the
    // single owner of `open`; the parent's onClose flips it.
    const onCancel = (e: Event) => {
      e.preventDefault()
      closeRef.current?.()
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === d) closeRef.current?.()
    }
    const onClosed = () => restore(openerRef)
    d.addEventListener('cancel', onCancel)
    d.addEventListener('pointerdown', onPointerDown)
    d.addEventListener('close', onClosed)
    return () => {
      d.removeEventListener('cancel', onCancel)
      d.removeEventListener('pointerdown', onPointerDown)
      d.removeEventListener('close', onClosed)
      restore(openerRef) // unmounted while open: no 'close' event fires
    }
  }, [])
  return ref
}

function restore(openerRef: { current: Element | null }) {
  const el = openerRef.current
  openerRef.current = null
  // Only if it is still on the page (the opener may have gone with the plate
  // it belonged to) and nothing else has taken focus meanwhile.
  if (el instanceof HTMLElement && el.isConnected) {
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) el.focus()
    })
  }
}
