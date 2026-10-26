import { useId, useState } from 'react'
import { Segmented } from '../../ui/ui.tsx'
import { ParamStrip } from '../../ui/Slider.tsx'
import type { ChangeHow } from '../../ui/param.ts'
import type { TextLayer } from '../../engine/types.ts'
import { atPassLimit, hasSwitchPoint, overPhotoOf, overPhotoPatch, type OverPhoto } from '../../state/settingsReducer.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { DockPanel, Rule } from './Dock.tsx'
import { InkButton, InkDialog } from './InkDialog.tsx'
import PlateButton from './PlateButton.tsx'
import { switchPointParam } from './params.ts'
import { BUDGET } from './plates.ts'
import { SUBS, type SubId } from './tools.ts'

/** Which ink a dialog is choosing. */
type Choosing = 'ink' | 'second' | 'backing' | null

/**
 * Ink: what colour the selected plate prints in, and what it does over the
 * photo. One choice per plate there, because the two cannot be combined: the
 * second ink reads the photo, but over a backing the ground is the block.
 *
 * Over photo is one options row (Off, Second ink, Backing) and under it the
 * one thing that choice needs: the second ink with its Switch point (the ink
 * button leads the strip, so it costs no row), the second ink alone when it
 * keeps the plate's own ink (both halves print that ink, so a Switch point
 * would move nothing and is not offered), or the backing's ink.
 */
export default function InkPanel({
  sub,
  onSub,
  hasPhoto,
}: {
  sub: SubId<'ink'>
  onSub: (sub: SubId<'ink'>) => void
  hasPhoto: boolean
}) {
  const { settings, dispatch, selectedLayer } = useSettings()
  const [choosing, setChoosing] = useState<Choosing>(null)
  const overHint = useId()
  const layer = selectedLayer ?? settings.layers[0]
  if (!layer) return null

  const set = (p: Partial<TextLayer>, how: ChangeHow) =>
    dispatch({ type: 'patchLayer', id: layer.id, patch: p, coalesce: !how.discrete, join: how.joins })
  const patch = (p: Partial<TextLayer>) => dispatch({ type: 'patchLayer', id: layer.id, patch: p })

  const over = overPhotoOf(layer)
  const passLimit = atPassLimit(settings)
  // Second ink reads the photo, so without one there is nothing to read; a
  // plate that already has one keeps it (it shows again with a photo).
  const secondOff = !hasPhoto && over !== 'second'
  const backingOff = passLimit && !layer.backing
  const tabs = SUBS.ink.map((t) => ({ ...t, on: t.id === 'over' && over !== 'off' }))
  const keeps = layer.contrastInkId === layer.inkId

  // What the Over photo choice needs said, in words, where a control cannot.
  const notes = [
    secondOff ? 'Second ink needs a photo behind the type.' : null,
    over === 'second' && !hasPhoto ? 'It shows once there is a photo behind the type.' : null,
    backingOff ? BUDGET : null,
  ].filter((n): n is string => n !== null)

  return (
    <DockPanel tool="ink" label="Ink" lead={<PlateButton />} tabs={tabs} sub={sub} onSub={onSub}>
      {sub === 'ink' && (
        <div className="controls__row">
          <span className="controls__label">Ink</span>
          <InkButton inkId={layer.inkId} what="this plate's ink" onClick={() => setChoosing('ink')} />
        </div>
      )}

      {sub === 'over' && (
        <>
          <Segmented<OverPhoto>
            label="Over the photo"
            value={over}
            describedBy={overHint}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'second', label: 'Second ink', disabled: secondOff },
              { id: 'backing', label: 'Backing', disabled: backingOff },
            ]}
            onChange={(v) => patch(overPhotoPatch(layer, v))}
          />
          <p className="sr-only" id={overHint}>
            One ink cannot read across a whole photograph. A second ink splits the pass by what is behind it, and
            the photo is cut back to paper where the ink is lighter than what it lands on. A backing is a block of
            ink behind each line, pressed first, with the photo cut back to paper under it.
          </p>
          {(over !== 'off' || notes.length > 0) && <Rule />}

          {over === 'second' && layer.contrastInkId && hasPhoto && hasSwitchPoint(layer) && (
            <ParamStrip
              key="switch"
              lead={<InkButton inkId={layer.contrastInkId} what="the second ink" onClick={() => setChoosing('second')} />}
              params={[switchPointParam(layer, set)]}
            />
          )}
          {over === 'second' && layer.contrastInkId && !(hasPhoto && hasSwitchPoint(layer)) && (
            <div className="controls__row">
              <span className="controls__label">Second ink</span>
              <InkButton
                inkId={layer.contrastInkId}
                text={keeps ? 'Keep this ink' : undefined}
                what="the second ink"
                onClick={() => setChoosing('second')}
              />
            </div>
          )}
          {over === 'backing' && layer.backing && (
            <div className="controls__row">
              <span className="controls__label">Backing ink</span>
              <InkButton inkId={layer.backing} what="the backing's ink" onClick={() => setChoosing('backing')} />
            </div>
          )}
          {notes.map((n) => (
            <p key={n} className="controls__hint">
              {n}
            </p>
          ))}
        </>
      )}

      {choosing === 'ink' && (
        <InkDialog title="Ink" value={layer.inkId} onPick={(inkId) => patch({ inkId })} onClose={() => setChoosing(null)} />
      )}
      {choosing === 'second' && layer.contrastInkId && (
        <InkDialog
          title="Second ink"
          value={layer.contrastInkId}
          keepInk={layer.inkId}
          exclude={layer.inkId}
          onPick={(contrastInkId) => patch({ contrastInkId })}
          onClose={() => setChoosing(null)}
        />
      )}
      {choosing === 'backing' && layer.backing && (
        <InkDialog title="Backing ink" value={layer.backing} onPick={(backing) => patch({ backing })} onClose={() => setChoosing(null)} />
      )}
    </DockPanel>
  )
}
