/**
 * The dock's tools and their sub-tabs: four tools, and a feature that does not
 * fit a tool's panel (one options row, a hairline, one parameter strip) is a
 * sub-tab of its own, never another row (Border Studio 34dabad, fcd91ff).
 *
 * Frame leads (the job is to frame a photo, then set type on it), with
 * Border Studio's crop glyph. It holds what Border Studio's Frame and Fill
 * tools did, and the photo: Border (the fill, Width, Corners and Frosted's
 * Blur), Crop (the ratio chips, then Crop or Fit), Place (Zoom and Position),
 * Photo (Choose, Replace, Remove).
 */

export const TOOLS = [
  { id: 'frame', label: 'Frame', icon: 'crop' },
  { id: 'type', label: 'Type', icon: 'type' },
  { id: 'ink', label: 'Ink', icon: 'droplet' },
  { id: 'press', label: 'Press', icon: 'press' },
] as const

export type ToolId = (typeof TOOLS)[number]['id']

export const SUBS = {
  frame: [
    { id: 'border', label: 'Border' },
    { id: 'crop', label: 'Crop' },
    { id: 'place', label: 'Place' },
    { id: 'photo', label: 'Photo' },
  ],
  type: [
    { id: 'text', label: 'Text' },
    { id: 'face', label: 'Face' },
    { id: 'size', label: 'Size' },
    { id: 'space', label: 'Space' },
    { id: 'place', label: 'Place' },
  ],
  ink: [
    // "Ink", not "Colour": beside the plate button, "Colour" and "Over photo"
    // (with its dot) overflow a 320px dock by 25px, and the row then starts
    // with a sliver of a word.
    { id: 'ink', label: 'Ink' },
    { id: 'over', label: 'Over photo' },
  ],
  press: [
    { id: 'screen', label: 'Screen' },
    { id: 'press', label: 'Press' },
    { id: 'paper', label: 'Paper' },
  ],
} as const

export type SubId<T extends ToolId> = (typeof SUBS)[T][number]['id']

/** The sub-tab each tool shows; kept per tool, so coming back to a tool
 *  finds it where it was left. (Frame opens on Photo while there is none:
 *  AppShell.) */
export type Subs = { [T in ToolId]: SubId<T> }

export const FIRST_SUBS: Subs = { frame: 'border', type: 'text', ink: 'ink', press: 'screen' }
