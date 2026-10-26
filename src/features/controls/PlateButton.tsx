import { useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ActionSheet, Icon } from '../../ui/ui.tsx'
import { cssRgb, inkById } from '../../engine/inks.ts'
import { nextLayerId } from '../../state/defaults.ts'
import { atPlateLimit } from '../../state/settingsReducer.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { BUDGET_SHORT, plateName } from './plates.ts'

/**
 * The plate the panel edits, at the start of the head row of BOTH Type and
 * Ink: one button, one selection, so "which plate" is answered where you
 * edit it (Border Studio's LayerPicker). It opens a sheet to switch plate,
 * add one or remove this one. Choosing a plate is not an undo step (it is
 * not the document); adding and removing are.
 *
 * A row of plate chips here cost every Type and Ink panel a row, which is
 * what makes the sheet jump between tools.
 */
export default function PlateButton() {
  const { settings, dispatch, selectedLayerId, selectLayer } = useSettings()
  const [open, setOpen] = useState(false)
  const layers = settings.layers
  const i = Math.max(0, layers.findIndex((l) => l.id === selectedLayerId))
  const sel = layers[i]
  const full = atPlateLimit(settings)
  const close = () => setOpen(false)
  if (!sel) return null

  const dot = (inkId: string) => (
    <span className="controls__markdot" style={{ '--swatch': cssRgb(inkById(inkId).rgb) } as CSSProperties} aria-hidden="true" />
  )
  const shown = plateName(sel, i)

  return (
    <>
      <button
        type="button"
        className="btn controls__layerbtn"
        data-size="sm"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The words on the button start its name (WCAG 2.5.3).
        aria-label={`${shown}, ${inkById(sel.inkId).name}: switch, add or remove plates`}
      >
        <span className="btn__label">
          {dot(sel.inkId)}
          <span className="controls__layername">{shown}</span>
        </span>
        <Icon name="chevron-down" />
      </button>
      {open &&
        createPortal(
          <ActionSheet open onClose={close} title="Plates">
            <div className="menu__group" role="group" aria-label="Plates, in the order they print">
              {layers.map((l, j) => (
                <button
                  key={l.id}
                  type="button"
                  className="menu__item"
                  role="menuitemradio"
                  aria-checked={l.id === sel.id}
                  onClick={() => {
                    selectLayer(l.id)
                    close()
                  }}
                >
                  <Icon name="check" className="menu__check" />
                  {dot(l.inkId)}
                  {plateName(l, j)}
                  <span className="menu__meta">{inkById(l.inkId).name}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="menu__item"
              role="menuitem"
              aria-disabled={full || undefined}
              onClick={() => {
                if (full) return
                const id = nextLayerId()
                dispatch({ type: 'addLayer', id })
                selectLayer(id)
                close()
              }}
            >
              <Icon name="plus" />
              New plate
              {/* Why it cannot, in the row itself (and so in its name). */}
              {full && <span className="menu__meta">{BUDGET_SHORT}</span>}
            </button>
            {layers.length > 1 && (
              <button
                type="button"
                className="menu__item"
                role="menuitem"
                data-tone="bad"
                onClick={() => {
                  close()
                  dispatch({ type: 'removeLayer', id: sel.id })
                }}
              >
                <Icon name="trash-2" />
                Remove {shown}
              </button>
            )}
          </ActionSheet>,
          document.body,
        )}
    </>
  )
}
