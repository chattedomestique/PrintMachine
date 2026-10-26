/**
 * The dock's tools and their sub-tabs: four tools, and a feature that does not
 * fit a tool's panel (one options row, a hairline, one parameter strip) is a
 * sub-tab of its own, never another row (Border Studio 34dabad, fcd91ff).
 */

export const TOOLS = [
  { id: 'type', label: 'Type', icon: 'type' },
  { id: 'ink', label: 'Ink', icon: 'droplet' },
  { id: 'photo', label: 'Photo', icon: 'image' },
  { id: 'press', label: 'Press', icon: 'press' },
] as const

export type ToolId = (typeof TOOLS)[number]['id']

export const SUBS = {
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
  photo: [
    { id: 'sheet', label: 'Sheet' },
    { id: 'frame', label: 'Frame' },
    { id: 'file', label: 'File' },
  ],
  press: [
    { id: 'screen', label: 'Screen' },
    { id: 'press', label: 'Press' },
    { id: 'paper', label: 'Paper' },
  ],
} as const

export type SubId<T extends ToolId> = (typeof SUBS)[T][number]['id']

/** The sub-tab each tool shows; kept per tool, so coming back to a tool
 *  finds it where it was left. */
export type Subs = { [T in ToolId]: SubId<T> }

export const FIRST_SUBS: Subs = { type: 'text', ink: 'ink', photo: 'sheet', press: 'screen' }
