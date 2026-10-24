/**
 * One numeric setting, Border Studio's way (4860519, 35326d8, c2dc669,
 * 4365fbd): its name and value on one line, the value a button you tap to type
 * an exact number, and under them the style guide's slider row, [−] track [+],
 * where a double-tap on the track resets the default. A panel with several
 * settings shows ONE at a time (the parameter strip); the others are one tap
 * (or one swipe up from the name) away in the parameter sheet, which costs no
 * layout while it is closed. That is what keeps the dock one height.
 *
 * Every rule (the two ranges, the nudge, the typed value, the reset) is a pure
 * function in param.ts, with a test; this file only wires them to markup.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ActionSheet, Icon } from './ui.tsx'
import { useModalDialog } from './useModalDialog.ts'
import {
  applyChange,
  canNudge,
  displayStep,
  draftOf,
  dragChange,
  doubleTapReset,
  dragPicks,
  isDoubleTap,
  nudgeChange,
  rangeText,
  resetChange,
  rowAt,
  swipeOpens,
  thumbValue,
  trackPosition,
  typedChange,
  type Param,
} from './param.ts'

/**
 * The style guide's slider row: [−] track [+]. The thumb shows the value
 * clamped into the slider's travel; the nudges step the TRUE value, so they
 * still work, and say so, beyond the track's ends. The − / + are the
 * single-pointer alternative to dragging (WCAG 2.5.7) and the precise step;
 * they go aria-disabled (not removed) only at the ends of the setting's range.
 */
export function Slider({ param }: { param: Param }) {
  // The last tap on the track: when, and whether the native range then moved
  // the thumb to it (it does, for a tap anywhere on the track).
  const lastTap = useRef({ at: 0, moved: false })
  // From a double tap's second pointer-down until that pointer is up, the
  // native range's own answer to the same touch (the thumb jumps to the
  // finger: an `input`, after the pointer-down) is ignored, so the reset
  // stands. Without this, a touch double tap ended where the finger was.
  const resetting = useRef(false)
  const id = useId()
  const off = param.unavailable !== undefined
  const reset = () => applyChange(param, resetChange(param))
  const step = (dir: 1 | -1) => applyChange(param, nudgeChange(param, dir))
  return (
    <div className="slider controls__slider" style={{ '--p': trackPosition(param) } as CSSProperties}>
      <div className="slider__row">
        <button
          type="button"
          className="btn ed-bare"
          data-shape="circle"
          data-size="sm"
          data-sg-nudge="-1"
          aria-label={`Decrease ${param.label}`}
          aria-controls={id}
          aria-disabled={off || !canNudge(param, -1) || undefined}
          onClick={() => step(-1)}
        >
          <Icon name="minus" />
        </button>
        <div className="slider__track">
          <input
            type="range"
            className="slider__input"
            id={id}
            min={param.trackMin}
            max={param.trackMax}
            step={param.step}
            value={thumbValue(param)}
            disabled={off}
            aria-label={param.label}
            // The true value, also when the thumb is pinned at an end.
            aria-valuetext={off ? param.unavailable : param.format(param.value)}
            onChange={(e) => {
              if (resetting.current) return
              const c = dragChange(param, Number(e.target.value))
              if (c && lastTap.current.at) lastTap.current.moved = true
              applyChange(param, c)
            }}
            // A mouse's double-click; after a double tap it finds the default
            // already there and changes nothing.
            onDoubleClick={reset}
            onPointerDown={() => {
              const now = performance.now()
              if (!isDoubleTap(lastTap.current.at, now)) {
                lastTap.current = { at: now, moved: false }
                return
              }
              applyChange(param, doubleTapReset(param, lastTap.current.moved))
              lastTap.current = { at: 0, moved: false }
              resetting.current = true
              const done = () => {
                resetting.current = false
                window.removeEventListener('pointerup', done, true)
                window.removeEventListener('pointercancel', done, true)
              }
              window.addEventListener('pointerup', done, true)
              window.addEventListener('pointercancel', done, true)
            }}
          />
        </div>
        <button
          type="button"
          className="btn ed-bare"
          data-shape="circle"
          data-size="sm"
          data-sg-nudge="1"
          aria-label={`Increase ${param.label}`}
          aria-controls={id}
          aria-disabled={off || !canNudge(param, 1) || undefined}
          onClick={() => step(1)}
        >
          <Icon name="plus" />
        </button>
      </div>
    </div>
  )
}

/**
 * Precise entry: the style guide's form dialog (a card on a native <dialog>),
 * in the units a person reads ("50", not "0.05"), with the whole range said in
 * words. The input is 16px or more so iOS never zooms onto it.
 */
function ValueModal({ param, onClose }: { param: Param; onClose: () => void }) {
  const [draft, setDraft] = useState(() => draftOf(param))
  const inputRef = useRef<HTMLInputElement>(null)
  // The hook returns focus to the value that opened this, whichever way it ends.
  const ref = useModalDialog(true, onClose)
  const titleId = useId()
  const rangeId = useId()

  useEffect(() => {
    const el = inputRef.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  const submit = () => {
    applyChange(param, typedChange(param, draft))
    onClose()
  }
  const bump = (dir: 1 | -1) => {
    const d = displayStep(param)
    const from = Number.parseFloat(draft.replace(/−/g, '-'))
    const base = Number.isFinite(from) ? from : param.toDisplay(param.value)
    const lo = param.toDisplay(param.min)
    const hi = param.toDisplay(param.max)
    const next = Math.min(Math.max(lo, hi), Math.max(Math.min(lo, hi), base + dir * d))
    setDraft(String(Number(next.toFixed(6))))
  }
  const negative = param.min < 0

  return createPortal(
    <dialog ref={ref} className="dialog card valuemodal" data-size="sm" aria-labelledby={titleId}>
      <form
        method="dialog"
        className="dialog__form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <header className="card__bar">
          <p className="card__label" id={titleId}>
            {param.label}
          </p>
        </header>
        <div className="card__body valuemodal__body">
          <div className="valuemodal__field">
            <button type="button" className="btn" data-shape="circle" aria-label={`Decrease ${param.label}`} onClick={() => bump(-1)}>
              <Icon name="minus" />
            </button>
            <input
              ref={inputRef}
              className="input num valuemodal__input"
              type={negative ? 'text' : 'number'}
              // iOS's decimal pad has no minus: a signed setting gets the text keyboard.
              inputMode={negative ? 'text' : 'decimal'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={param.label}
              aria-describedby={rangeId}
            />
            <button type="button" className="btn" data-shape="circle" aria-label={`Increase ${param.label}`} onClick={() => bump(1)}>
              <Icon name="plus" />
            </button>
          </div>
          <p className="t-meta num valuemodal__range" id={rangeId}>
            {rangeText(param)}
          </p>
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" data-variant="primary">
            Set
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  )
}

/**
 * The value beside a setting's name: the style guide's slider readout (plain
 * text, tabular figures), made a button so a tap types an exact number. It
 * shows the TRUE value, also past the slider's ends.
 */
export function EditableValue({ param }: { param: Param }) {
  const [editing, setEditing] = useState(false)
  const display = param.format(param.value)
  return (
    <>
      <button
        type="button"
        className="controls__value num"
        onClick={() => setEditing(true)}
        aria-label={`${param.label} ${display}, tap to type`}
        aria-haspopup="dialog"
      >
        {display}
      </button>
      {editing && <ValueModal param={param} onClose={() => setEditing(false)} />}
    </>
  )
}

/**
 * Which setting the strip sets: an action sheet (plainly ON TOP: it rises from
 * the bottom, framed, over a scrim). Pick by tap, or Snapseed's way: the finger
 * that swiped up from the strip's name keeps going, and lifting on a row picks
 * it. The drag is read from the window, because the pointer is still captured
 * by the name it went down on, and a row only counts once the finger has moved
 * (dragPicks), so the opening swipe cannot pick the row that rose under it.
 */
function ParamPicker({
  params,
  currentKey,
  onPick,
  onClose,
  title = 'Adjust',
}: {
  params: readonly Param[]
  currentKey: string
  onPick: (key: string) => void
  onClose: () => void
  title?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const done = useRef({ onPick, onClose })
  useEffect(() => {
    done.current = { onPick, onClose }
  })

  useEffect(() => {
    const keyAt = (y: number) =>
      rowAt(
        [...(listRef.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].map((el) => {
          const r = el.getBoundingClientRect()
          return { key: el.dataset.key ?? '', top: r.top, bottom: r.bottom }
        }),
        y,
      )
    let from: number | null = null
    let dragging = false
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && !e.buttons) return
      if (from === null) from = e.clientY
      if (!dragging && !dragPicks(from, e.clientY)) return
      dragging = true
      setDrag(keyAt(e.clientY))
    }
    const onUp = (e: PointerEvent) => {
      const k = dragging ? keyAt(e.clientY) : null
      from = null
      dragging = false
      setDrag(null)
      if (k) {
        done.current.onPick(k)
        done.current.onClose()
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  return createPortal(
    <ActionSheet open onClose={onClose} title={title} label={`${title}: choose a setting`} listRef={listRef}>
      {params.map((p) => (
        <button
          key={p.key}
          data-key={p.key}
          type="button"
          className="menu__item"
          role="menuitemradio"
          aria-checked={p.key === currentKey}
          data-drag={drag === p.key ? '' : undefined}
          onClick={() => {
            onPick(p.key)
            onClose()
          }}
        >
          <Icon name="check" className="menu__check" />
          {p.label}
          <span className="menu__meta num">{p.unavailable ? '—' : p.format(p.value)}</span>
        </button>
      ))}
    </ActionSheet>,
    document.body,
  )
}

/**
 * One setting on screen, the rest one tap away — Snapseed's control strip, as
 * Border Studio has it. Permanently on screen: the setting's name (with the
 * up/down chevrons that say "there are more", when there are), its value, and
 * the slider. A `lead` (a colour button, say) goes at the start of the name's
 * line, so a second control costs no row.
 */
export function ParamStrip({ params, lead }: { params: readonly (Param | null | false | undefined)[]; lead?: ReactNode }) {
  const all = params.filter((p): p is Param => !!p)
  const [key, setKey] = useState(all[0]?.key)
  const [pickOpen, setPickOpen] = useState(false)
  const swipe = useRef<{ y: number; fired: boolean } | null>(null)

  const cur = all.find((p) => p.key === key) ?? all[0]
  if (!cur) return null
  const multi = all.length > 1

  return (
    <div className="paramstrip">
      <div className="paramstrip__head">
        {lead}
        {multi ? (
          <button
            type="button"
            className="paramstrip__pick"
            onPointerDown={(e) => {
              swipe.current = { y: e.clientY, fired: false }
            }}
            onPointerMove={(e) => {
              const s = swipe.current
              if (s && !s.fired && swipeOpens(s.y, e.clientY)) {
                s.fired = true
                setPickOpen(true)
              }
            }}
            onPointerUp={() => {
              swipe.current = null
            }}
            onClick={() => {
              if (!pickOpen) setPickOpen(true)
            }}
            aria-haspopup="dialog"
            aria-expanded={pickOpen}
            aria-label={`${cur.label}: choose a setting`}
          >
            <Icon name="chevrons-up-down" />
            {cur.label}
          </button>
        ) : (
          <span className="paramstrip__name">{cur.label}</span>
        )}
        {cur.unavailable ? (
          <span className="controls__hint paramstrip__why">{cur.unavailable}</span>
        ) : (
          <EditableValue param={cur} />
        )}
      </div>
      <Slider param={cur} />

      {pickOpen && (
        <ParamPicker params={all} currentKey={cur.key} onPick={setKey} onClose={() => setPickOpen(false)} />
      )}
    </div>
  )
}
