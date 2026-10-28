import { describe, expect, it } from 'vitest'
import { TOOLS } from '../controls/tools.ts'
import { FIT_GESTURES, PHOTO_GESTURES, TYPE_GESTURES, gestureHint } from './hint.ts'

describe('the gesture hint', () => {
  it('reads the open tool: the photo with Frame open on Original and in Crop, none in Fit, the type otherwise', () => {
    expect(gestureHint('frame', 'crop')).toBe(PHOTO_GESTURES)
    expect(gestureHint('frame', 'fit')).toBe(FIT_GESTURES)
    for (const mode of ['crop', 'fit'] as const) {
      expect(gestureHint(null, mode)).toBe(TYPE_GESTURES)
      for (const t of TOOLS.filter((t) => t.id !== 'frame')) expect(gestureHint(t.id, mode)).toBe(TYPE_GESTURES)
    }
  })

  it("leads with the photo's drag and pinch (the plan's words for them), and names no gesture in Fit", () => {
    expect(PHOTO_GESTURES).toMatch(/^Drag to move the photo · pinch to zoom/)
    expect(FIT_GESTURES).not.toMatch(/drag|pinch|double/i)
  })
})
