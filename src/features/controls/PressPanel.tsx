import { useId } from 'react'
import { Icon, Segmented, SwatchSet } from '../../ui/ui.tsx'
import { ParamStrip } from '../../ui/Slider.tsx'
import type { ChangeHow } from '../../ui/param.ts'
import { cssRgb, PAPERS } from '../../engine/inks.ts'
import type { PressProfile, ScreenMethod } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { DockPanel, Rule } from './Dock.tsx'
import { pressParams, screenParam } from './params.ts'
import { SUBS, type SubId } from './tools.ts'

const METHODS: readonly { id: ScreenMethod; label: React.ReactNode; aria: string }[] = [
  {
    id: 'halftone',
    label: (
      <>
        <Icon name="halftone" />
        Halftone
      </>
    ),
    aria: 'Halftone',
  },
  {
    id: 'grain',
    label: (
      <>
        <Icon name="grain" />
        Grain
      </>
    ),
    aria: 'Grain',
  },
]

const STOCKS = PAPERS.map((p) => ({ id: p.id, label: p.name, color: cssRgb(p.rgb) }))

/** A seed other than the current one, so Re-roll always changes the sheet. */
function newSeed(current: number): number {
  for (;;) {
    const seed = Math.floor(Math.random() * 100000)
    if (seed !== current) return seed
  }
}

/**
 * Press: the machine, not the artwork; everything here applies to every
 * plate. Screen (dots or grain, and one size for both), Press (how much ink,
 * how far each pass lands from the last, how ragged the letters, how blotchy
 * the ink; and Re-roll, another pull of the same settings), Paper (the stock
 * every ink multiplies onto).
 */
export default function PressPanel({ sub, onSub }: { sub: SubId<'press'>; onSub: (sub: SubId<'press'>) => void }) {
  const { settings, dispatch } = useSettings()
  const rerollHint = useId()
  const press = settings.press
  const set = (p: Partial<PressProfile>, how: ChangeHow) => dispatch({ type: 'patchPress', patch: p, coalesce: !how.discrete })

  return (
    <DockPanel tool="press" label="Press" tabs={SUBS.press} sub={sub} onSub={onSub}>
      {sub === 'screen' && (
        <>
          <Segmented label="Screen" value={press.method} options={METHODS} onChange={(method) => dispatch({ type: 'patchPress', patch: { method } })} />
          <Rule />
          <ParamStrip key="screen" params={[screenParam(press, set)]} />
        </>
      )}

      {sub === 'press' && (
        <>
          <div className="controls__row">
            <span className="controls__label" id={rerollHint}>
              Pull another sheet
            </span>
            {/* A different tear, mottle, registration and paper grain from the
                same settings. Its own undo step. */}
            <button
              type="button"
              className="btn"
              data-size="sm"
              aria-describedby={rerollHint}
              onClick={() => dispatch({ type: 'patch', patch: { seed: newSeed(settings.seed) } })}
            >
              <span className="btn__label">
                <Icon name="shuffle" />
                Re-roll
              </span>
            </button>
          </div>
          <Rule />
          <ParamStrip key="press" params={pressParams(press, set)} />
        </>
      )}

      {sub === 'paper' && (
        <SwatchSet
          legend="Paper stock"
          items={STOCKS}
          value={settings.paperId}
          onPick={(it) => dispatch({ type: 'patch', patch: { paperId: it.id } })}
        />
      )}
    </DockPanel>
  )
}
