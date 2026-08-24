import TypePanel from './TypePanel.tsx'
import InkPanel from './InkPanel.tsx'
import PressPanel from './PressPanel.tsx'
import PaperPanel from './PaperPanel.tsx'
import BoxPanel from './BoxPanel.tsx'
import MediaPanel from './MediaPanel.tsx'
import WearPanel from './WearPanel.tsx'
import { Segmented } from '../../ui/controls.tsx'
import type { PressTarget } from '../../state/settingsReducer.ts'
import { useState } from 'react'
import { useSettings } from '../../state/settingsStore.ts'
import './Controls.css'

const PRESS_TARGETS: readonly { value: PressTarget; label: string }[] = [
  { value: 'press', label: 'Type' },
  { value: 'photoPress', label: 'Photo' },
]

export const TABS = [
  { id: 'type', label: 'Type' },
  { id: 'ink', label: 'Ink' },
  { id: 'box', label: 'Box' },
  { id: 'media', label: 'Photo' },
  { id: 'press', label: 'Press' },
  { id: 'wear', label: 'Wear' },
  { id: 'paper', label: 'Paper' },
] as const

export type TabId = (typeof TABS)[number]['id']

/**
 * The control body for whichever tab is open.
 *
 * Owns no tab state of its own — the shell does, because the shell also owns
 * the overlay whose height the canvas has to reserve. Splitting that across
 * two components is how the canvas ends up sized against a stale overlay.
 */
export default function Controls({ tab }: { tab: TabId | null }) {
  // Which press the Press and Wear tabs are editing. Shared between them
  // rather than held per panel, so switching tabs does not silently switch
  // back to the type and let a photo edit land on the wrong pass.
  const [pressTarget, setPressTarget] = useState<PressTarget>('press')
  const { settings } = useSettings()
  if (!tab) return null

  const pressTabs = tab === 'press' || tab === 'wear'
  return (
    <div className="control-group">
      {pressTabs && (
        <div className="press-target">
          <Segmented
            label="Which press"
            value={pressTarget}
            options={PRESS_TARGETS}
            onChange={setPressTarget}
          />
          <p className="panel-note">
            {pressTarget === 'press'
              ? 'Editing the pass the type goes through.'
              : settings.media
                ? 'Editing the pass the photo goes through, when it is printed.'
                : 'Editing the photo’s pass — import a photo to see it.'}
          </p>
        </div>
      )}
      {tab === 'type' && <TypePanel />}
      {tab === 'ink' && <InkPanel />}
      {tab === 'box' && <BoxPanel />}
      {tab === 'media' && <MediaPanel />}
      {tab === 'press' && <PressPanel target={pressTarget} />}
      {tab === 'wear' && <WearPanel target={pressTarget} />}
      {tab === 'paper' && <PaperPanel />}
    </div>
  )
}
