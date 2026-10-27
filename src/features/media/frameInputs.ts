/**
 * What the frame's fill is made from, beyond the document (engine/frame.ts
 * `FrameInputs`): derived from the photo here, in the page, and handed to
 * the engine beside the photo. The engine never decodes and never caches
 * them.
 */

import type { FrameInputs } from '../../engine/frame.ts'
import type { PrintSettings } from '../../engine/types.ts'

/** The inputs a document already holds: the palette stored with its photo
 *  (`media.palette`), when it has been computed. A fill whose input is not
 *  here draws as Paper until it is. */
export const storedFrameInputs = (s: Pick<PrintSettings, 'media'>): FrameInputs => (s.media?.palette ? { palette: s.media.palette } : {})
