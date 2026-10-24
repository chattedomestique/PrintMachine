import { useId } from 'react'
import { Icon, Segmented } from '../../ui/ui.tsx'
import { ParamStrip } from '../../ui/Slider.tsx'
import type { ChangeHow } from '../../ui/param.ts'
import { FONTS, sheetAspect, type TextAlign, type TextLayer } from '../../engine/types.ts'
import { fitSize } from '../../engine/text.ts'
import { canvasMeasure } from '../../state/persist.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { DockPanel, Rule } from './Dock.tsx'
import PlateButton from './PlateButton.tsx'
import { placeParams, sizeParam, spaceParams } from './params.ts'
import { SUBS, type SubId } from './tools.ts'

const ALIGNS: readonly { id: TextAlign; label: string }[] = [
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Centre' },
  { id: 'right', label: 'Right' },
  // Forced justification: every line, the last included, stretched to the
  // widest — by its word gaps where it has any, by its letters where not.
  { id: 'justify', label: 'Justify' },
]

/** The faces, the poster face first: the default plate's. Each name is set in
 *  its own face, the way a type menu shows them. */
const FACES = ['poster', 'grotesk', 'serif', 'mono'].map((id) => FONTS.find((f) => f.id === id)!)

/**
 * Type: the words of the selected plate and how they are set. Five sub-tabs,
 * each one row and a strip at most: Text (the words), Face (typeface and
 * Bold), Size (Fit, and the Size slider: a tenth of the sheet reads 100%),
 * Space (alignment, line height, tracking), Place (rotation and position, the
 * tap equivalents of turning and dragging the type on the sheet).
 */
export default function TypePanel({ sub, onSub }: { sub: SubId<'type'>; onSub: (sub: SubId<'type'>) => void }) {
  const { settings, dispatch, selectedLayer } = useSettings()
  const textHint = useId()
  const fitHint = useId()
  const layer = selectedLayer ?? settings.layers[0]
  if (!layer) return null

  /** A slider's change: a drag coalesces into one undo step. */
  const set = (p: Partial<TextLayer>, how: ChangeHow) =>
    dispatch({ type: 'patchLayer', id: layer.id, patch: p, coalesce: !how.discrete, join: how.joins })
  /** A tap's change: its own undo step. */
  const patch = (p: Partial<TextLayer>) => dispatch({ type: 'patchLayer', id: layer.id, patch: p })

  // One-shot: the size at which the widest line spans the sheet, stored, so
  // there is only ever one size. Editing the text afterwards does not re-fit;
  // tapping Fit again does. Its own undo step.
  const fit = () => {
    const measure = canvasMeasure()
    if (measure) patch({ size: fitSize(layer, sheetAspect(settings), measure) })
  }

  return (
    <DockPanel tool="type" label="Type" lead={<PlateButton />} tabs={SUBS.type} sub={sub} onSub={onSub}>
      {sub === 'text' && (
        <>
          <textarea
            className="input controls__textarea"
            aria-label="Text"
            aria-describedby={textHint}
            rows={3}
            value={layer.text}
            spellCheck={false}
            // The keyboard asks iOS for capitals; what is typed is what prints.
            autoCapitalize="characters"
            placeholder="Type something"
            // Typing coalesces into one undo step, like a drag.
            onChange={(e) => dispatch({ type: 'patchLayer', id: layer.id, patch: { text: e.target.value }, coalesce: true })}
          />
          <p className="sr-only" id={textHint}>
            Each line breaks where you break it. On the sheet: drag the type to move it, pinch to size and turn it,
            double-tap to centre it.
          </p>
        </>
      )}

      {sub === 'face' && (
        <>
          <Segmented
            label="Typeface"
            value={layer.fontId as (typeof FACES)[number]['id']}
            options={FACES.map((f) => ({ id: f.id, label: <span style={{ fontFamily: f.stack }}>{f.name}</span>, aria: f.name }))}
            onChange={(fontId) => patch({ fontId: fontId as TextLayer['fontId'] })}
          />
          <Rule />
          {/* Regular or bold: heavier strokes survive the screen, the tear and
              the bleed. A circle holding its letter, Border Studio's form, on
              a row of its own: beside four face names it does not fit a
              320px phone, and a row that wraps leaves it alone on a line. */}
          <div className="controls__row">
            <span className="controls__label" aria-hidden="true">
              Bold
            </span>
            <button
              type="button"
              className="btn controls__letter"
              data-shape="circle"
              data-size="sm"
              aria-pressed={layer.bold}
              aria-label="Bold"
              onClick={() => patch({ bold: !layer.bold })}
            >
              B
            </button>
          </div>
        </>
      )}

      {sub === 'size' && (
        <>
          <div className="controls__row">
            <span className="controls__label" id={fitHint}>
              Widest line to the sheet
            </span>
            <button type="button" className="btn" data-size="sm" aria-describedby={fitHint} onClick={fit}>
              <span className="btn__label">
                <Icon name="chevrons-left-right" />
                Fit
              </span>
            </button>
          </div>
          <Rule />
          <ParamStrip key="size" params={[sizeParam(layer, set)]} />
        </>
      )}

      {sub === 'space' && (
        <>
          <Segmented label="Alignment" value={layer.align} options={ALIGNS} onChange={(align) => patch({ align })} />
          <Rule />
          <ParamStrip key="space" params={spaceParams(layer, set)} />
        </>
      )}

      {sub === 'place' && <ParamStrip key="place" params={placeParams(layer, set)} />}
    </DockPanel>
  )
}
