import { useEffect, useId, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Icon, SwatchSet, type SwatchItem } from '../../ui/ui.tsx'
import { useModalDialog } from '../../ui/useModalDialog.ts'
import { cssRgb, inkById, RISO_INKS } from '../../engine/inks.ts'

/** The id of the "Keep this ink" choice in the second-ink dialog. */
const KEEP = 'keep'

/**
 * A button that names an ink and opens its dialog: the ink as a chip and its
 * NAME, so nobody has to tell two inks apart by eye.
 */
export function InkButton({ inkId, text, what, onClick }: { inkId: string; text?: string; what: string; onClick: () => void }) {
  const name = text ?? inkById(inkId).name
  return (
    <button
      type="button"
      className="btn controls__inkbtn"
      data-size="sm"
      data-ink-button=""
      aria-haspopup="dialog"
      // The words on the button start its name (WCAG 2.5.3).
      aria-label={`${name}: ${what}, tap to change`}
      onClick={onClick}
    >
      <span className="btn__label">
        <span className="controls__inkchip" style={{ '--swatch': cssRgb(inkById(inkId).rgb) } as CSSProperties} aria-hidden="true" />
        <span className="controls__inkname">{name}</span>
      </span>
      <Icon name="chevron-down" />
    </button>
  )
}

/**
 * The whole ink table in a dialog: 77 Riso inks are data, and a dialog costs
 * the dock no room (a swatch line of 77 would be a scroller nobody finishes).
 * In the table's order, fluorescents first: they are the reason to print Riso
 * at all. A pick applies at once (each its own undo step) and the print behind
 * the scrim shows it; Done closes.
 *
 * For a second ink, "Keep this ink" comes first: both halves print the plate's
 * own ink, and the photo is cut back to paper wherever it is darker than the
 * ink. It is chosen when the second ink IS the plate's ink.
 */
export function InkDialog({
  title,
  value,
  keepInk,
  exclude,
  onPick,
  onClose,
}: {
  title: string
  /** The ink chosen now. */
  value: string
  /** Offer "Keep this ink" first, for the plate whose ink this is. */
  keepInk?: string
  /** An ink not to offer (the plate's own, where Keep stands for it). */
  exclude?: string
  onPick: (inkId: string) => void
  onClose: () => void
}) {
  const ref = useModalDialog(true, onClose)
  const titleId = useId()
  const items: SwatchItem[] = [
    ...(keepInk ? [{ id: KEEP, label: `Keep this ink (${inkById(keepInk).name})`, color: cssRgb(inkById(keepInk).rgb) }] : []),
    ...RISO_INKS.filter((i) => i.id !== exclude).map((i) => ({ id: i.id, label: i.name, color: cssRgb(i.rgb) })),
  ]
  const chosen = keepInk && value === keepInk ? KEEP : value

  // Open on the chosen ink, in view: with 77 the list scrolls.
  useEffect(() => {
    const input = ref.current?.querySelector<HTMLInputElement>('input[type=radio]:checked')
    input?.focus()
    input?.closest('label')?.scrollIntoView({ block: 'center' })
  }, [ref])

  return createPortal(
    <dialog ref={ref} className="dialog card inkdialog" data-size="sm" aria-labelledby={titleId}>
      <header className="card__bar">
        <p className="card__label" id={titleId}>
          {title}
        </p>
      </header>
      <div className="card__body inkdialog__body">
        <SwatchSet
          legend={title}
          items={items}
          value={chosen}
          onPick={(it) => onPick(it.id === KEEP && keepInk ? keepInk : it.id)}
        />
      </div>
      <div className="dialog__actions">
        <button type="button" className="btn" data-variant="primary" data-block="" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>,
    document.body,
  )
}
