/**
 * The save flow as a pure state machine: a press that outlasts its tap waits
 * for a fresh one, Cancel works while it presses, a failed share keeps the
 * file, the preview pauses, Save waits for the document's photo, and a print
 * too big for the device, or a save the app died during, is put as a question
 * in numbers.
 */

import { describe, expect, it } from 'vitest'

import { planExport } from '../../engine/exportPlan.ts'
import {
  IDLE,
  SHARE_AT_ONCE_MS,
  canStart,
  pressInProgress,
  progressText,
  saveButton,
  saveQuestion,
  saveReducer,
  type SaveEvent,
  type SaveState,
} from './useSave.ts'

const photo = { width: 3024, height: 4032, scale: 1 }
const plan = planExport(4 / 5, photo)
const planAt = (maxHeight: number) => planExport(4 / 5, photo, { maxHeight })
const file = new File([new Uint8Array(6_200_000)], 'print-machine.jpg', { type: 'image/jpeg' })
const run = (events: SaveEvent[], from: SaveState = IDLE) => events.reduce(saveReducer, from)
const kinds = (events: SaveEvent[]) => {
  const seen: string[] = []
  events.reduce((s, e) => {
    const next = saveReducer(s, e)
    seen.push(next.kind)
    return next
  }, IDLE as SaveState)
  return seen
}

describe('the save flow', () => {
  it('idle → loading the photo → pressing → ready → a tap shares → idle', () => {
    expect(
      kinds([
        { type: 'start', format: 'jpeg', plan, photo: true },
        { type: 'photoLoaded' },
        { type: 'progress', progress: { step: 'press', pass: 1, passes: 2 } },
        { type: 'pressed', file, now: false },
        { type: 'share' },
        { type: 'delivered' },
      ]),
    ).toEqual(['loadingPhoto', 'pressing', 'pressing', 'ready', 'sharing', 'idle'])
  })

  it('no photo: straight to pressing; a press within a second of the tap shares at once', () => {
    expect(SHARE_AT_ONCE_MS).toBe(1000)
    expect(
      kinds([
        { type: 'start', format: 'png', plan, photo: false },
        { type: 'pressed', file, now: true },
        { type: 'delivered' },
      ]),
    ).toEqual(['pressing', 'sharing', 'idle'])
  })

  it('Cancel stops a press, while the photo loads or while it presses', () => {
    expect(run([{ type: 'start', format: 'jpeg', plan, photo: true }, { type: 'cancelled' }])).toEqual(IDLE)
    expect(run([{ type: 'start', format: 'jpeg', plan, photo: true }, { type: 'photoLoaded' }, { type: 'cancelled' }])).toEqual(IDLE)
    // A finished file is not cancelled by a late abort.
    const ready = run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'pressed', file, now: false }])
    expect(saveReducer(ready, { type: 'cancelled' })).toBe(ready)
  })

  it('a share that fails keeps the file and the button for another tap', () => {
    const sharing = run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'pressed', file, now: true }])
    expect(sharing.kind).toBe('sharing')
    const again = saveReducer(sharing, { type: 'shareFailed' })
    expect(again).toEqual({ kind: 'ready', file, plan })
    expect(saveButton(again, 'none')).toEqual({ text: 'Save to Photos (6.2 MB)', disabled: false })
  })

  it('an error says why, with the numbers, and a new tap starts over', () => {
    const failed = run([
      { type: 'start', format: 'jpeg', plan, photo: true },
      { type: 'failed', message: 'Could not press 3024×3780: out of memory' },
    ])
    expect(progressText(failed)).toBe('Could not press 3024×3780: out of memory')
    expect(run([{ type: 'start', format: 'jpeg', plan, photo: false }], failed).kind).toBe('pressing')
    expect(saveReducer(failed, { type: 'dismiss' })).toEqual(IDLE)
  })

  it('an edit drops a file waiting for its tap, and an old error; never a press in flight', () => {
    const ready = run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'pressed', file, now: false }])
    expect(saveReducer(ready, { type: 'documentChanged' })).toEqual(IDLE)
    expect(saveReducer({ kind: 'error', message: 'x' }, { type: 'documentChanged' })).toEqual(IDLE)
    const pressing = run([{ type: 'start', format: 'jpeg', plan, photo: false }])
    expect(saveReducer(pressing, { type: 'documentChanged' })).toBe(pressing)
  })

  it('a second start while pressing is ignored', () => {
    const pressing = run([{ type: 'start', format: 'jpeg', plan, photo: false }])
    expect(saveReducer(pressing, { type: 'start', format: 'png', plan, photo: false })).toBe(pressing)
  })

  it('pauses the preview exactly while the photo loads and the print is pressed', () => {
    const states = [
      IDLE,
      run([{ type: 'start', format: 'jpeg', plan, photo: true }]),
      run([{ type: 'start', format: 'jpeg', plan, photo: false }]),
      run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'pressed', file, now: false }]),
      run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'pressed', file, now: true }]),
    ]
    expect(states.map(pressInProgress)).toEqual([false, true, true, false, false])
  })

  it('waits for the document\'s photo: Loading photo while it decodes, refused when it failed', () => {
    expect(canStart(IDLE, 'loading')).toBe(false)
    expect(saveButton(IDLE, 'loading')).toEqual({ text: 'Loading photo', disabled: true })
    expect(canStart(IDLE, 'failed')).toBe(false)
    expect(saveButton(IDLE, 'failed')).toEqual({ text: 'Save', disabled: true })
    expect(canStart(IDLE, 'ready')).toBe(true)
    expect(canStart(IDLE, 'none')).toBe(true)
  })

  it('says how far the press has got, in pixels and plates', () => {
    const start = run([{ type: 'start', format: 'jpeg', plan, photo: true }])
    expect(progressText(start)).toBe('Pressing 3024×3780: loading the photo')
    const pressing = run([{ type: 'photoLoaded' }, { type: 'progress', progress: { step: 'press', pass: 2, passes: 3 } }], start)
    expect(progressText(pressing)).toBe('Pressing 3024×3780, plate 2 of 3')
    expect(saveButton(pressing, 'ready')).toEqual({ text: 'Cancel', disabled: false })
    expect(progressText(saveReducer(pressing, { type: 'progress', progress: { step: 'print', pass: 3, passes: 3 } }))).toBe(
      'Pressing 3024×3780: printing the sheet',
    )
    expect(progressText(IDLE)).toBeNull()
  })
})

describe('a print too big for this device, and a save that did not finish', () => {
  const smaller = planAt(2835)

  it('a press that fails for size asks about a smaller copy; it never starts one by itself', () => {
    const pressing = run([{ type: 'start', format: 'png', plan, photo: true }, { type: 'photoLoaded' }])
    const asked = saveReducer(pressing, { type: 'tooBig', failed: plan, smaller })
    expect(asked).toEqual({ kind: 'tooBig', format: 'png', failed: plan, smaller })
    expect(pressInProgress(asked)).toBe(false)
    expect(saveQuestion(asked, planAt)).toEqual({
      text: "This device couldn't press 3024×3780. Save a smaller 2268×2835 copy instead?",
      choices: [{ label: 'Save smaller', height: 2835 }],
    })
    // Choosing it starts a press at that size, in the format asked for.
    expect(saveReducer(asked, { type: 'start', format: 'png', plan: smaller, photo: true })).toEqual({
      kind: 'loadingPhoto',
      format: 'png',
      plan: smaller,
    })
    expect(saveReducer(asked, { type: 'dismiss' })).toEqual(IDLE)
    // Only a press can fail for size.
    expect(saveReducer(IDLE, { type: 'tooBig', failed: plan, smaller })).toBe(IDLE)
  })

  it('with no copy this device can press, it says so and offers nothing', () => {
    const asked = run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'tooBig', failed: plan, smaller: null }])
    expect(saveQuestion(asked, planAt)).toEqual({
      text: "This device couldn't press 3024×3780, nor a copy smaller than it: it cannot save this print.",
      choices: [],
    })
  })

  it('a save the app went away during is said at launch: the same again, or a step smaller', () => {
    const notice = saveReducer(IDLE, { type: 'interrupted', format: 'jpeg', height: 3780 })
    expect(saveQuestion(notice, planAt)).toEqual({
      text: 'The last save, 3024×3780, did not finish.',
      choices: [
        { label: 'Try again', height: 3780 },
        { label: 'Save smaller (2268×2835)', height: 2835 },
      ],
    })
    expect(canStart(notice, 'ready')).toBe(true)
    expect(saveButton(notice, 'ready')).toEqual({ text: 'Save', disabled: false })
    expect(progressText(notice)).toBeNull()
    // Its offer is worked out from the document as it is, so an edit keeps it;
    // a smaller copy worked out for a failed press is dropped.
    expect(saveReducer(notice, { type: 'documentChanged' })).toBe(notice)
    const asked = run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'tooBig', failed: plan, smaller }])
    expect(saveReducer(asked, { type: 'documentChanged' })).toEqual(IDLE)
    // Never over a save in progress.
    const pressing = run([{ type: 'start', format: 'jpeg', plan, photo: false }])
    expect(saveReducer(pressing, { type: 'interrupted', format: 'jpeg', height: 3780 })).toBe(pressing)
  })

  it('no question otherwise', () => {
    expect(saveQuestion(IDLE, planAt)).toBeNull()
    expect(saveQuestion({ kind: 'error', message: 'x' }, planAt)).toBeNull()
  })
})
