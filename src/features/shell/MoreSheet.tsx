import { ActionSheet, Icon } from '../../ui/ui.tsx'
import type { SWState } from '../../state/swStatus.ts'
import type { MoreCaption } from './useSave.ts'

/** The offline signal in words: an icon AND a word, never a colour alone. */
const OFFLINE_WORDS: Record<SWState, { icon: string; word: string; meta: string }> = {
  ready: { icon: 'circle-check', word: 'Works offline', meta: 'Everything it needs is saved on this device.' },
  pending: { icon: 'download', word: 'Saving for offline', meta: 'Keep it open online until this says it works offline.' },
  unsupported: { icon: 'wifi-off', word: 'Offline unavailable', meta: 'This browser cannot keep the app for offline use.' },
}

/**
 * More: the rarer things, as an action sheet (the same surface as the
 * parameter picker, so everything that opens on top looks it). First two
 * facts — what Save makes, in pixels and, when it is not the photo's own, why
 * (or, while the photo cannot be loaded, that nothing can be saved); and
 * whether the app will open with no network, and which build it is — then
 * the one rarer action: the lossless PNG.
 */
export default function MoreSheet({
  open,
  onClose,
  caption,
  pngSize,
  swState,
  canSavePng,
  onSavePng,
}: {
  open: boolean
  onClose: () => void
  /** What Save makes, or why it cannot (useSave.ts moreCaption). */
  caption: MoreCaption
  /** What the lossless PNG makes ("2419×3024", and its file's size where it
   *  is stored uncompressed); null when no size is promised. */
  pngSize: string | null
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
      infoLabel="What Save makes, and offline"
      info={
        <div className="more__facts">
          <div className="more__fact" data-export-size={caption.size ?? ''} data-alert={caption.alert || undefined}>
            <Icon name={caption.alert ? 'circle-alert' : 'image'} />
            <p className="more__fact-word num">{caption.word}</p>
            <p className="more__fact-meta">{caption.meta}</p>
          </div>
          <div className="more__fact" data-offline-row={swState}>
            <Icon name={offline.icon} />
            <p className="more__fact-word">{offline.word}</p>
            <p className="more__fact-meta">{offline.meta}</p>
            {/* Which build this is (Border Studio's stamp): what is kept for
                offline is this build, and an installed app updates itself
                with nothing else to say it did. */}
            <p className="more__fact-meta more__build" data-build={__BUILD_ID__}>
              Build {__BUILD_ID__}
            </p>
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
        {caption.size && pngSize && <span className="menu__meta num">{pngSize}</span>}
      </button>
    </ActionSheet>
  )
}
