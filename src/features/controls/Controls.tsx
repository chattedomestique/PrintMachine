import TypePanel from './TypePanel.tsx'
import InkPanel from './InkPanel.tsx'
import PressPanel from './PressPanel.tsx'
import MediaPanel from './MediaPanel.tsx'
import type { MediaState } from '../media/useMediaBitmap.ts'
import './Controls.css'

export const TABS = [
  { id: 'type', label: 'Type' },
  { id: 'ink', label: 'Ink' },
  { id: 'media', label: 'Photo' },
  { id: 'press', label: 'Press' },
] as const

export type TabId = (typeof TABS)[number]['id']

/**
 * The control body for whichever tab is open.
 *
 * Owns no tab state of its own — the shell does, because the shell also owns
 * the overlay whose height the canvas has to reserve. Splitting that across
 * two components is how the canvas ends up sized against a stale overlay.
 */
export default function Controls({ tab, mediaState }: { tab: TabId | null; mediaState: MediaState }) {
  if (!tab) return null
  return (
    <div className="control-group">
      {tab === 'type' && <TypePanel />}
      {tab === 'ink' && <InkPanel />}
      {tab === 'media' && <MediaPanel mediaState={mediaState} />}
      {tab === 'press' && <PressPanel />}
    </div>
  )
}
