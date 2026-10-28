import FramePanel from './FramePanel.tsx'
import TypePanel from './TypePanel.tsx'
import InkPanel from './InkPanel.tsx'
import PressPanel from './PressPanel.tsx'
import type { PhotoState } from '../media/frameInputs.ts'
import type { PhotoImport } from '../media/usePhotoImport.ts'
import type { Subs, ToolId } from './tools.ts'

/**
 * The panel of whichever tool is open.
 *
 * Owns no tool or sub-tab state of its own — the shell does, because the shell
 * also owns the overlay whose height the sheet has to reserve. Splitting that
 * across two components is how the sheet ends up sized against a stale
 * overlay.
 */
export default function Controls({
  tool,
  subs,
  onSub,
  mediaState,
  fillPreparing,
  photo,
}: {
  tool: ToolId | null
  subs: Subs
  onSub: <T extends ToolId>(tool: T, sub: Subs[T]) => void
  mediaState: PhotoState
  /** The frame's fill is still being made from the photo (useFrameInputs). */
  fillPreparing: boolean
  photo: PhotoImport
}) {
  if (!tool) return null
  return (
    <div className="controls">
      {tool === 'frame' && <FramePanel sub={subs.frame} onSub={(s) => onSub('frame', s)} mediaState={mediaState} fillPreparing={fillPreparing} photo={photo} />}
      {tool === 'type' && <TypePanel sub={subs.type} onSub={(s) => onSub('type', s)} />}
      {tool === 'ink' && <InkPanel sub={subs.ink} onSub={(s) => onSub('ink', s)} hasPhoto={mediaState !== 'none'} />}
      {tool === 'press' && <PressPanel sub={subs.press} onSub={(s) => onSub('press', s)} />}
    </div>
  )
}
