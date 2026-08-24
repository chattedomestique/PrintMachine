import { useMemo, useState } from 'react'
import { Field, IconButton, Slider, Swatches } from '../../ui/controls.tsx'
import { PlusIcon, TrashIcon } from '../../ui/icons.tsx'
import { cssRgb, inkById, RISO_INKS } from '../../engine/inks.ts'
import type { TextLayer } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * The words of a layer, in reading order.
 *
 * Deliberately derived from the raw text rather than from the render layout:
 * the selection UI needs a word list before anything has been rasterised, and
 * splitting on whitespace is exactly the same rule `groupWords` applies in the
 * engine. Both must agree on what counts as a word or the indices a box stores
 * would point at different words than the ones highlighted here.
 */
function wordsOf(layer: TextLayer): string[] {
  const raw = layer.caps ? layer.text.toUpperCase() : layer.text
  return raw.split(/\s+/).filter((t) => t.length > 0)
}

export default function BoxPanel() {
  const { settings, dispatch, selectedLayer } = useSettings()
  const layer = selectedLayer ?? settings.layers[0]
  const [activeBoxId, setActiveBoxId] = useState<string | null>(null)

  const words = useMemo(() => (layer ? wordsOf(layer) : []), [layer])
  if (!layer) return null

  const boxes = layer.boxes
  // Falls back to the *last* box, not the first: a box is appended, and the
  // thing you want to configure right after adding one is the one you just
  // added. Falling back to boxes[0] silently sends your word taps to a
  // different box than the one the strip appears to have highlighted.
  const active = boxes.find((b) => b.id === activeBoxId) ?? boxes[boxes.length - 1] ?? null

  const patchLayer = (p: Partial<TextLayer>, coalesce = false) =>
    dispatch({ type: 'patchLayer', id: layer.id, patch: p, coalesce })

  /** Which box, if any, already owns a given word — drives the chip colour. */
  const ownerOf = (index: number) => boxes.find((b) => b.words.includes(index))

  return (
    <div className="control-stack">
      <p className="panel-note">
        Boxes print as their own plate under the type, so they screen, misregister and wear exactly
        like everything else on the sheet.
      </p>

      <Field label={`Boxes · ${boxes.length}`}>
        {boxes.length > 0 && (
          <div className="plate-strip">
            {boxes.map((b, i) => {
              const ink = inkById(b.inkId)
              return (
                <button
                  key={b.id}
                  type="button"
                  className="plate"
                  aria-pressed={b.id === active?.id}
                  onClick={() => setActiveBoxId(b.id)}
                >
                  <span
                    className="plate-dot"
                    style={{ background: cssRgb(ink.rgb) }}
                    aria-hidden="true"
                  />
                  <span className="plate-text">
                    {b.words.length ? `${b.words.length} word${b.words.length > 1 ? 's' : ''}` : `Box ${i + 1}`}
                  </span>
                  <span className="plate-ink">{ink.name}</span>
                </button>
              )
            })}
          </div>
        )}
        <div className="plate-actions">
          <IconButton
            label="Add a box"
            onClick={() => {
              dispatch({ type: 'addBox', layerId: layer.id })
              // Clear the pin so the fallback lands on the new box.
              setActiveBoxId(null)
            }}
          >
            <PlusIcon />
          </IconButton>
          <IconButton
            label="Delete this box"
            disabled={!active}
            onClick={() => {
              if (!active) return
              dispatch({ type: 'removeBox', layerId: layer.id, boxId: active.id })
              setActiveBoxId(null)
            }}
          >
            <TrashIcon />
          </IconButton>
          <span className="plate-hint">
            {boxes.length === 0
              ? 'Add a box, then tap the words it should sit behind.'
              : 'Tap words below to put them in the selected box.'}
          </span>
        </div>
      </Field>

      {active && (
        <>
          <Field label="Words">
            {words.length === 0 ? (
              <p className="plate-hint">This plate has no text yet.</p>
            ) : (
              <>
              <div className="chip-actions">
                <button
                  type="button"
                  className="icon-button"
                  disabled={active.words.length === words.length}
                  onClick={() =>
                    dispatch({
                      type: 'setBoxWords',
                      layerId: layer.id,
                      boxId: active.id,
                      words: words.map((_, i) => i),
                    })
                  }
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={active.words.length === 0}
                  onClick={() =>
                    dispatch({ type: 'setBoxWords', layerId: layer.id, boxId: active.id, words: [] })
                  }
                >
                  Clear
                </button>
              </div>
              <div className="word-chips" role="group" aria-label="Words in this plate">
                {words.map((word, i) => {
                  const owner = ownerOf(i)
                  const mine = owner?.id === active.id
                  const ink = owner ? inkById(owner.inkId) : null
                  return (
                    <button
                      key={`${word}-${i}`}
                      type="button"
                      className="word-chip"
                      aria-pressed={mine}
                      // Words owned by another box show that box's ink, so it
                      // is obvious why tapping moves them rather than stacking.
                      style={
                        owner
                          ? { background: cssRgb(ink!.rgb), borderColor: 'transparent', color: '#fff' }
                          : undefined
                      }
                      onClick={() =>
                        dispatch({ type: 'toggleBoxWord', layerId: layer.id, boxId: active.id, word: i })
                      }
                    >
                      {word}
                    </button>
                  )
                })}
              </div>
              </>
            )}
          </Field>

          <Field label="Box ink" value={inkById(active.inkId).name}>
            <Swatches
              label="Box ink"
              value={active.inkId}
              options={RISO_INKS}
              onChange={(inkId) =>
                dispatch({ type: 'patchBox', layerId: layer.id, boxId: active.id, patch: { inkId } })
              }
            />
          </Field>

          <Slider
            label="Box opacity"
            value={active.opacity}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(opacity) =>
              dispatch({
                type: 'patchBox',
                layerId: layer.id,
                boxId: active.id,
                patch: { opacity },
                coalesce: true,
              })
            }
          />
        </>
      )}

      {/* Padding and radius are per-layer rather than per-box: boxes on the
          same type should share a shape, or the block reads as a ransom note. */}
      <Slider
        label="Box padding"
        value={layer.boxPadding}
        min={0}
        max={0.6}
        step={0.01}
        format={(v) => `${v.toFixed(2)}em`}
        onChange={(boxPadding) => patchLayer({ boxPadding }, true)}
      />

      <Slider
        label="Corner radius"
        value={layer.boxRadius}
        min={0}
        max={0.8}
        step={0.01}
        format={(v) => (v === 0 ? 'square' : `${v.toFixed(2)}em`)}
        onChange={(boxRadius) => patchLayer({ boxRadius }, true)}
      />
    </div>
  )
}
