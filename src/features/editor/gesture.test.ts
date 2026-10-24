/**
 * The gesture arithmetic (gesture.ts): what a touch on the sheet writes, and
 * to which plate. The pointer bookkeeping round it is useLayerGestures.ts;
 * the browser run of the whole path is scripts/check-touch.mjs.
 */

import { describe, expect, it } from 'vitest'

import { defaultSettings, makeLayer } from '../../state/defaults.ts'
import { historyReducer, initHistory } from '../../state/settingsReducer.ts'
import { SIZE_MAX, SIZE_MIN } from '../../engine/limits.ts'
import { DRAG_SLOP, beginGesture, stepGesture, type GestureLimits, type GesturePatch } from './gesture.ts'

const LIMITS: GestureLimits = { size: [SIZE_MIN, SIZE_MAX], position: [-0.3, 1.3] }
const BOX = { width: 400, height: 500 }

/** Two plates, A selected (the editor's default: the first), B elsewhere. */
function twoPlates() {
  const a = makeLayer({ text: 'A', x: 0.3, y: 0.3, size: 0.05, rotation: -4 })
  const b = makeLayer({ text: 'B', x: 0.7, y: 0.8, size: 0.02, rotation: 10 })
  return { a, b, history: initHistory({ ...defaultSettings(), layers: [a, b] }) }
}

/** What the editor does with a step's patch: one coalescing edit of the plate
 *  the gesture holds, by its id (Canvas.tsx). */
const dispatchStep = (h: ReturnType<typeof initHistory>, id: string, patch: GesturePatch | null) =>
  patch ? historyReducer(h, { type: 'patchLayer', id, patch, coalesce: true }) : h

describe('a touch on the sheet', () => {
  it('a tap writes nothing: a pixel or two of wobble is not a drag, and no undo step is pushed', () => {
    const { b, history } = twoPlates()
    // A tap that picks B: the gesture is begun on B, then wobbles.
    let g = beginGesture(b, [{ x: 280, y: 400 }], false)
    let h = history
    for (const pt of [{ x: 281, y: 401 }, { x: 282, y: 399 }, { x: 280 + DRAG_SLOP, y: 400 }]) {
      const step = stepGesture(g, [pt], BOX, LIMITS)
      expect(step.patch).toBeNull()
      g = step.gesture
      h = dispatchStep(h, g.target.id, step.patch)
    }
    expect(h).toBe(history)
    expect(h.past).toHaveLength(0)
  })

  it('the first move after a tap-pick moves the TAPPED plate from its own origin, and leaves the selected one alone (it is seeded into the gesture at the pointer-down)', () => {
    const { a, b, history } = twoPlates()
    // At the pointer-down that picks B the editor still has A selected; the
    // gesture is seeded from B, not from the selection.
    const g = beginGesture(b, [{ x: 280, y: 400 }], false)
    expect(g.target).toEqual({ id: b.id, x: b.x, y: b.y, size: b.size, rotation: b.rotation })
    const step = stepGesture(g, [{ x: 320, y: 350 }], BOX, LIMITS)
    expect(step.patch).toEqual({ x: b.x + 40 / BOX.width, y: b.y - 50 / BOX.height })
    const h = dispatchStep(history, g.target.id, step.patch)
    const [a2, b2] = h.present.layers
    expect(a2).toEqual(a)
    expect(b2.x).toBeCloseTo(0.8)
    expect(b2.y).toBeCloseTo(0.7)
    expect(b2.size).toBe(b.size)
    expect(b2.rotation).toBe(b.rotation)
    expect(h.past).toHaveLength(1)
  })

  it('past the slop a drag follows the finger exactly, from where it went down', () => {
    const { b } = twoPlates()
    let g = beginGesture(b, [{ x: 100, y: 100 }], false)
    const first = stepGesture(g, [{ x: 100 + DRAG_SLOP + 1, y: 100 }], BOX, LIMITS)
    expect(first.patch?.x).toBeCloseTo(b.x + (DRAG_SLOP + 1) / BOX.width)
    g = first.gesture
    expect(g.live).toBe(true)
    // Back inside the slop: still a drag, and the plate goes back with it.
    const back = stepGesture(g, [{ x: 101, y: 100 }], BOX, LIMITS)
    expect(back.patch?.x).toBeCloseTo(b.x + 1 / BOX.width)
  })

  it('two fingers pinch and turn at once, with no slop, from the plate the gesture holds', () => {
    const { b } = twoPlates()
    const g = beginGesture(b, [{ x: 100, y: 100 }, { x: 200, y: 100 }], false)
    expect(g.live).toBe(true)
    const step = stepGesture(g, [{ x: 100, y: 100 }, { x: 100, y: 300 }], BOX, LIMITS)
    // Spread 100 -> 200 doubles B's size; the pair turned a quarter turn.
    expect(step.patch?.size).toBeCloseTo(b.size * 2)
    expect(step.patch?.rotation).toBeCloseTo(b.rotation + 90)
  })

  it('a finger lifting mid-pinch leaves the other still dragging (the handoff stays live)', () => {
    const { b } = twoPlates()
    const pinch = beginGesture(b, [{ x: 100, y: 100 }, { x: 200, y: 100 }], false)
    const handoff = beginGesture({ ...b, x: 0.6 }, [{ x: 100, y: 100 }], pinch.live)
    const step = stepGesture(handoff, [{ x: 101, y: 100 }], BOX, LIMITS)
    expect(step.patch?.x).toBeCloseTo(0.6 + 1 / BOX.width)
  })

  it('pan and pinch stay inside the limits they are given', () => {
    const { b } = twoPlates()
    const g = beginGesture(b, [{ x: 0, y: 0 }], false)
    const far = stepGesture(g, [{ x: 4000, y: -4000 }], BOX, LIMITS).patch
    expect(far).toEqual({ x: 1.3, y: -0.3 })
    const pinch = beginGesture(b, [{ x: 0, y: 0 }, { x: 10, y: 0 }], false)
    expect(stepGesture(pinch, [{ x: 0, y: 0 }, { x: 10000, y: 0 }], BOX, LIMITS).patch?.size).toBe(SIZE_MAX)
  })
})
