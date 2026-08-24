import { useState } from 'react'
import { Field, Slider } from '../../ui/controls.tsx'
import { useSettings } from '../../state/settingsStore.ts'
import type { TextLayer } from '../../engine/types.ts'

/** Whitespace split — the same rule the engine groups words by, so an index
 *  here means the same word it means on the sheet. */
function wordsOf(layer: TextLayer): string[] {
  const raw = layer.caps ? layer.text.toUpperCase() : layer.text
  return raw.split(/\s+/).filter((t) => t.length > 0)
}

/**
 * Per-word press overrides.
 *
 * Bleed and offset are things that happen to a *plate*, so a word given either
 * is pulled onto its own plate and run through the press separately — which is
 * also exactly how a real second hit on one word would behave. Words sharing a
 * setting share a plate, so they tear and land together.
 */
export default function WordPanel() {
  const { settings, dispatch, selectedLayer } = useSettings()
  const [selected, setSelected] = useState<number[]>([])
  const layer = selectedLayer ?? settings.layers[0]
  if (!layer) return null

  const words = wordsOf(layer)
  // Nothing selected means "the words already overridden", so the sliders
  // always have something meaningful to move.
  const targets =
    selected.length > 0 ? selected : words.map((_, i) => i).filter((i) => layer.wordPress[String(i)])
  const first = targets.length > 0 ? layer.wordPress[String(targets[0])] : undefined

  const set = (patch: { bleed?: number; offset?: number }) => {
    if (targets.length === 0) return
    dispatch({ type: 'setWordPress', layerId: layer.id, words: targets, patch, coalesce: true })
  }

  return (
    <div className="control-stack">
      <p className="panel-note">
        A word given extra bleed or its own offset comes off the main plate and goes through the
        press separately — a second hit, landing where the rest of the line did not.
      </p>

      <Field label={selected.length ? `Words · ${selected.length} selected` : 'Words'}>
        {words.length === 0 ? (
          <p className="plate-hint">This plate has no text yet.</p>
        ) : (
          <div className="word-chips" role="group" aria-label="Words to misprint">
            {words.map((word, i) => {
              const over = layer.wordPress[String(i)]
              return (
                <button
                  key={`${word}-${i}`}
                  type="button"
                  className="word-chip"
                  aria-pressed={selected.includes(i)}
                  data-tracked={over ? true : undefined}
                  onClick={() =>
                    setSelected((prev) =>
                      prev.includes(i) ? prev.filter((n) => n !== i) : [...prev, i],
                    )
                  }
                >
                  {word}
                  {over && (
                    <span className="word-chip-badge">
                      {over.bleed ? 'b' : ''}
                      {over.offset ? 'o' : ''}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </Field>

      <Slider
        label={targets.length ? 'Extra bleed' : 'Tap words first'}
        value={first?.bleed ?? 0}
        min={0}
        max={0.6}
        step={0.01}
        format={(v) => (v === 0 ? 'none' : `+${Math.round(v * 100)}%`)}
        onChange={(bleed) => set({ bleed })}
      />
      <Slider
        label={targets.length ? 'Extra offset' : 'Tap words first'}
        value={first?.offset ?? 0}
        min={0}
        max={30}
        step={0.5}
        format={(v) => (v === 0 ? 'none' : `+${v}px`)}
        onChange={(offset) => set({ offset })}
      />
      <p className="panel-note">
        Offset is on top of the sheet’s own misregistration, and each group gets its own
        registration seed — that is what makes the word land somewhere the line did not.
      </p>
    </div>
  )
}
