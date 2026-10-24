import type { Ref } from 'react'
import { Icon } from '../../ui/ui.tsx'
import type { SaveStatus } from './useSave.ts'

/**
 * The save's status, a card on the floating plane just above the dock: how
 * far a press has got, with Cancel (the rest of the page is inert while it
 * presses, so this card is the one thing that answers); a file waiting for
 * its Share; an error; "Loading the photo"; a photo that could not be loaded,
 * with the way to choose it again. Its words come from useSave.ts
 * (saveStatus), which has no UI in it.
 */
export default function StatusCard({
  status,
  cancelRef,
  onCancel,
  onDiscard,
  onDismiss,
  onChoose,
}: {
  status: SaveStatus | null
  /** Cancel, which the shell focuses while the print is pressed. */
  cancelRef?: Ref<HTMLButtonElement>
  onCancel: () => void
  onDiscard: () => void
  onDismiss: () => void
  onChoose: () => void
}) {
  if (!status) return null
  return (
    <div
      className="card app__status"
      data-alert={status.alert || undefined}
      data-action={status.action ?? undefined}
      data-delay={status.delay ? '' : undefined}
    >
      {/* The words and their symbol, one piece: when the action does not fit
          beside them (a narrow screen, large text) it goes under them, at
          the card's end, rather than squeezing them into a column. */}
      <div className="app__status-body">
        {status.busy && (
          <span className="spinner" data-size="sm" aria-hidden="true">
            <span className="spinner__ring" />
          </span>
        )}
        {status.alert && <Icon name="circle-alert" />}
        <p className="app__status-text num" role={status.alert ? 'alert' : 'status'}>
          {status.text}
        </p>
      </div>
      {status.action === 'cancel' && (
        // The rest of the page is inert while the print is pressed, so focus
        // comes here, to the one thing that answers (AppShell.tsx moves it).
        <button ref={cancelRef} type="button" className="btn" data-size="sm" onClick={onCancel}>
          Cancel
        </button>
      )}
      {status.action === 'choose' && (
        <button type="button" className="btn" data-size="sm" onClick={onChoose}>
          Choose again
        </button>
      )}
      {(status.action === 'discard' || status.action === 'dismiss') && (
        <button
          type="button"
          className="btn ed-bare"
          data-shape="circle"
          data-size="sm"
          aria-label={status.action === 'discard' ? 'Discard the file' : 'Dismiss'}
          onClick={status.action === 'discard' ? onDiscard : onDismiss}
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  )
}
