import { ActionSheet, Icon } from '../../ui/ui.tsx'
import type { SWState } from '../../state/swStatus.ts'

/** The offline signal in words: an icon AND a word, never a colour alone. */
const OFFLINE_WORDS: Record<SWState, { icon: string; word: string; meta: string }> = {
  ready: { icon: 'circle-check', word: 'Works offline', meta: 'Everything it needs is saved on this device.' },
  pending: { icon: 'download', word: 'Saving for offline', meta: 'Keep it open online until this says it works offline.' },
  unsupported: { icon: 'wifi-off', word: 'Offline unavailable', meta: 'This browser cannot keep the app for offline use.' },
}

/**
 * More: the rarer things, as an action sheet (the same surface as the
 * parameter picker, so everything that opens on top looks it). First two
 * facts — what Save makes, in pixels and, when it is not the photo's own, why;
 * and whether the app will open with no network — then the one rarer action:
 * the lossless PNG.
 */
export default function MoreSheet({
  open,
  onClose,
  size,
  meta,
  swState,
  canSavePng,
  onSavePng,
}: {
  open: boolean
  onClose: () => void
  /** What Save makes ("2419×3024"). */
  size: string
  /** What that size is: why it is not the photo's own pixels, in numbers, or
   *  that it is. */
  meta: string
  swState: SWState
  canSavePng: boolean
  onSavePng: () => void
}) {
  const offline = OFFLINE_WORDS[swState]
  return (
    <ActionSheet
      open={open}
      onClose={onClose}
      label="More"
      info={
        <div className="more__facts">
          <div className="more__fact" data-export-size={size}>
            <Icon name="image" />
            <p className="more__fact-word num">Saves {size}</p>
            <p className="more__fact-meta">{meta}</p>
          </div>
          <div className="more__fact" data-offline-row={swState}>
            <Icon name={offline.icon} />
            <p className="more__fact-word">{offline.word}</p>
            <p className="more__fact-meta">{offline.meta}</p>
          </div>
        </div>
      }
    >
      <button
        type="button"
        className="menu__item"
        role="menuitem"
        aria-disabled={!canSavePng || undefined}
        onClick={() => {
          if (!canSavePng) return
          onClose()
          onSavePng()
        }}
      >
        <Icon name="download" />
        Save lossless PNG
        <span className="menu__meta num">{size}</span>
      </button>
    </ActionSheet>
  )
}
