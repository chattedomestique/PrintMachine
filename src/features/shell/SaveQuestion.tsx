import { useId } from 'react'
import { useModalDialog } from '../../ui/useModalDialog.ts'
import { Icon } from '../../ui/ui.tsx'
import type { PhotoState } from '../media/frameInputs.ts'
import { saveRefusal, type SaveChoice } from './useSave.ts'

/**
 * A save that cannot go on unasked, put as the style guide's confirm dialog (a
 * card on a native <dialog>: the page behind is inert, Esc and a tap on the
 * scrim cancel). Two questions reach it (useSave.ts saveQuestion): a print
 * this device could not press ("Save a smaller 1814×2268 copy instead?"), and
 * a save that did not finish last time ("Try again", "Save smaller").
 *
 * The first choice offered is the answer the question asks for, so it is the
 * primary button and has focus; Cancel is always there. Asked at launch, the
 * question can come before the photo is back: its choices wait for it, as Save
 * does, and say so.
 */
export default function SaveQuestion({
  question,
  mediaState,
  canAnswer,
  onAnswer,
  onDismiss,
}: {
  question: { title: string; text: string; choices: SaveChoice[] } | null
  mediaState: PhotoState
  canAnswer: boolean
  onAnswer: (height: number) => void
  onDismiss: () => void
}) {
  const ref = useModalDialog(question !== null, onDismiss)
  const titleId = useId()
  const textId = useId()
  const refused = saveRefusal(mediaState)
  const waiting = question !== null && question.choices.length > 0 && (mediaState === 'loading' || refused !== null)

  return (
    <dialog ref={ref} className="dialog card savequestion" data-size="sm" aria-labelledby={titleId} aria-describedby={textId}>
      {question && (
        <>
          <header className="card__bar">
            <p className="card__label">Save</p>
          </header>
          <div className="card__body">
            <h2 className="card__title" id={titleId}>
              {question.title}
            </h2>
            <p className="card__text num" id={textId}>
              {question.text}
            </p>
            {waiting && mediaState === 'loading' && (
              <p className="card__text savequestion__wait" role="status">
                Loading the photo…
              </p>
            )}
            {waiting && refused && (
              <p className="card__text savequestion__wait" role="alert">
                <Icon name="circle-alert" />
                {refused}
              </p>
            )}
          </div>
          <div className="dialog__actions">
            <button type="button" className="btn" onClick={onDismiss}>
              {question.choices.length ? 'Cancel' : 'OK'}
            </button>
            {question.choices.map((choice, i) => (
              <button
                key={choice.label}
                type="button"
                className="btn num"
                data-variant={i === 0 ? 'primary' : undefined}
                // Focused as the dialog opens (useModalDialog). Waiting, it is
                // aria-disabled, not disabled, as Save is: it keeps focus, and
                // a tap does nothing until the photo is back.
                data-autofocus={i === 0 ? '' : undefined}
                aria-disabled={!canAnswer || undefined}
                onClick={() => {
                  if (canAnswer) onAnswer(choice.height)
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </>
      )}
    </dialog>
  )
}
