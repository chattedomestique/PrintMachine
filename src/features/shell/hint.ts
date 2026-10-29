/**
 * The gesture hint's words (AppShell): what the sheet's gestures do with the
 * open tool, so it never teaches a gesture that does something else. Pure,
 * so each case has a test (hint.test.ts).
 */

import type { ToolId } from '../controls/tools.ts'

/** With Frame open, on Original and in Crop: the photo's gestures. */
export const PHOTO_GESTURES = 'Drag to move the photo · pinch to zoom · double‑tap to reset'
/** With Frame open in Fit: the whole photo shows, so there are none. */
export const FIT_GESTURES = 'Fit shows the whole photo · choose Crop to move or zoom it'
/** With any other tool open, or none: the type's gestures. */
export const TYPE_GESTURES = 'Tap type to pick it · drag to move · pinch to size and turn'

/**
 * What the sheet's gestures do with `tool` open: with Frame they are the
 * photo's (one finger moves it, two zoom it, a double tap resets it), except
 * in Fit, where the whole photo shows inside the frame and there is nothing
 * to move or zoom; with any other tool, or none, they are the type's.
 *
 * @param mode the layout's mode (frame.ts `effectiveMode`: Original is Crop).
 */
export function gestureHint(tool: ToolId | null, mode: 'crop' | 'fit'): string {
  if (tool !== 'frame') return TYPE_GESTURES
  return mode === 'fit' ? FIT_GESTURES : PHOTO_GESTURES
}
