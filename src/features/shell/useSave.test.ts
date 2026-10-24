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
  saveLabel,
  saveQuestion,
  saveStatus,
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
    expect(saveButton(again, 'none')).toEqual({ text: 'Share', busy: false, disabled: false })
    expect(saveLabel(again, 'none', '3024×3780')).toBe('Share 3024×3780 (6.2 MB)')
    expect(saveStatus(again, 'none')).toEqual({
      text: '3024×3780 is ready (6.2 MB). Tap Share to save it.',
      alert: false,
      busy: false,
      action: 'discard',
    })
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

  it('waits for the document\'s photo: Save disabled and the card saying so while it decodes, refused when it failed', () => {
    expect(canStart(IDLE, 'loading')).toBe(false)
    expect(saveButton(IDLE, 'loading')).toStrictEqual({ text: 'Save', busy: false, disabled: true })
    expect(saveLabel(IDLE, 'loading', '2419×3024')).toBe('Save: loading the photo')
    expect(saveStatus(IDLE, 'loading')).toEqual({ text: 'Loading the photo…', alert: false, busy: true, action: null, delay: true })
    expect(canStart(IDLE, 'failed')).toBe(false)
    expect(canStart(IDLE, 'ready')).toBe(true)
    expect(canStart(IDLE, 'none')).toBe(true)
    // Nothing to say otherwise: Save is one word, the size is in its name.
    expect(saveStatus(IDLE, 'ready')).toBeNull()
    expect(saveStatus(IDLE, 'none')).toBeNull()
    expect(saveButton(IDLE, 'ready')).toStrictEqual({ text: 'Save', busy: false, disabled: false })
    expect(saveLabel(IDLE, 'ready', '2419×3024')).toBe('Save 2419×3024 JPEG')
  })

  it('a photo that could not be loaded: Save says why, in the card and in its name, and promises no size', () => {
    const why = 'This photo could not be loaded. Choose it again.'
    expect(saveButton(IDLE, 'failed')).toStrictEqual({ text: 'Save', busy: false, disabled: true, why })
    expect(saveLabel(IDLE, 'failed', '2419×3024')).toBe(`Save: ${why}`)
    // The card is the alert, with the way out: choose the photo again.
    expect(saveStatus(IDLE, 'failed')).toEqual({ text: why, alert: true, busy: false, action: 'choose' })
    // Over an old error, a question, or an unfinished save's notice too.
    const error: SaveState = { kind: 'error', message: 'Could not press 2419×3024: x' }
    for (const s of [error, saveReducer(IDLE, { type: 'interrupted', format: 'jpeg', height: 3780 })]) {
      expect(saveButton(s, 'failed').why).toBe(why)
      expect(saveStatus(s, 'failed')).toEqual({ text: why, alert: true, busy: false, action: 'choose' })
    }
    // A file already pressed is still the print it was: it can be shared.
    const ready = run([{ type: 'start', format: 'jpeg', plan, photo: true }, { type: 'photoLoaded' }, { type: 'pressed', file, now: false }])
    expect(saveButton(ready, 'failed')).toStrictEqual({ text: 'Share', busy: false, disabled: false })
    expect(saveStatus(ready, 'failed')?.text).toBe('3024×3780 is ready (6.2 MB). Tap Share to save it.')
  })

  it('the card: an error is an alert with a dismiss; progress is busy, with Cancel', () => {
    expect(saveStatus({ kind: 'error', message: 'Could not press: x' }, 'ready')).toEqual({
      text: 'Could not press: x',
      alert: true,
      busy: false,
      action: 'dismiss',
    })
    const pressing = run([
      { type: 'start', format: 'jpeg', plan, photo: false },
      { type: 'progress', progress: { step: 'press', pass: 1, passes: 2 } },
    ])
    expect(saveStatus(pressing, 'none')).toEqual({ text: 'Pressing 3024×3780, plate 1 of 2', alert: false, busy: true, action: 'cancel' })
    expect(saveStatus(run([{ type: 'start', format: 'jpeg', plan, photo: true }]), 'ready')?.action).toBe('cancel')
    const sharing = run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'pressed', file, now: true }])
    expect(saveStatus(sharing, 'none')).toEqual({ text: 'Saving 3024×3780', alert: false, busy: true, action: null })
    // A question is a dialog of its own, not a card.
    expect(saveStatus(saveReducer(IDLE, { type: 'interrupted', format: 'jpeg', height: 3780 }), 'ready')).toBeNull()
  })

  it('Save is one word in every state, so the bar never wraps', () => {
    const states: SaveState[] = [
      IDLE,
      run([{ type: 'start', format: 'jpeg', plan, photo: true }]),
      run([{ type: 'start', format: 'jpeg', plan, photo: false }]),
      run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'pressed', file, now: false }]),
      run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'pressed', file, now: true }]),
      { kind: 'error', message: 'x' },
      saveReducer(IDLE, { type: 'interrupted', format: 'jpeg', height: 3780 }),
    ]
    for (const s of states) {
      for (const m of ['none', 'loading', 'ready', 'failed'] as const) {
        const b = saveButton(s, m)
        expect(['Save', 'Saving', 'Share']).toContain(b.text)
        // The name starts with the word on screen (WCAG 2.5.3).
        expect(saveLabel(s, m, '3024×3780').startsWith(b.text)).toBe(true)
      }
    }
  })

  it('says how far the press has got, in pixels and plates', () => {
    const start = run([{ type: 'start', format: 'jpeg', plan, photo: true }])
    expect(progressText(start)).toBe('Pressing 3024×3780: loading the photo')
    // Before its first step a press claims nothing (a print with no photo lays
    // none down); then the photo, the plates and the sheet.
    expect(progressText(run([{ type: 'start', format: 'jpeg', plan, photo: false }]))).toBe('Pressing 3024×3780')
    expect(progressText(run([{ type: 'photoLoaded' }, { type: 'progress', progress: { step: 'photo', pass: 0, passes: 3 } }], start))).toBe(
      'Pressing 3024×3780: laying down the photo',
    )
    const pressing = run([{ type: 'photoLoaded' }, { type: 'progress', progress: { step: 'press', pass: 2, passes: 3 } }], start)
    expect(progressText(pressing)).toBe('Pressing 3024×3780, plate 2 of 3')
    expect(saveButton(pressing, 'ready')).toEqual({ text: 'Saving', busy: true, disabled: true })
    expect(saveLabel(pressing, 'ready', '3024×3780')).toBe('Saving 3024×3780')
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
    const asked = saveReducer(pressing, { type: 'tooBig', failed: plan, why: 'a canvas that size came back blank', smaller })
    expect(asked).toEqual({ kind: 'tooBig', format: 'png', failed: plan, why: 'a canvas that size came back blank', smaller })
    expect(pressInProgress(asked)).toBe(false)
    expect(saveQuestion(asked, planAt)).toEqual({
      title: 'Too big for this device',
      text: "This device couldn't press 3024×3780 (a canvas that size came back blank). Save a smaller 2268×2835 copy instead?",
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
    expect(saveReducer(IDLE, { type: 'tooBig', failed: plan, why: 'a canvas that size came back blank', smaller })).toBe(IDLE)
  })

  it('with no copy this device can press, it says so and offers nothing', () => {
    const asked = run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'tooBig', failed: plan, why: 'Out of memory', smaller: null }])
    expect(saveQuestion(asked, planAt)).toEqual({
      title: 'Too big for this device',
      text: "This device couldn't press 3024×3780 (Out of memory), nor a copy smaller than it: it cannot save this print.",
      choices: [],
    })
  })

  it('a save the app went away during is said at launch: the same again, or a step smaller', () => {
    const notice = saveReducer(IDLE, { type: 'interrupted', format: 'jpeg', height: 3780 })
    expect(saveQuestion(notice, planAt)).toEqual({
      title: 'A save did not finish',
      text: 'The last save, 3024×3780, did not finish.',
      choices: [
        { label: 'Try again', height: 3780 },
        { label: 'Save smaller (2268×2835)', height: 2835 },
      ],
    })
    expect(canStart(notice, 'ready')).toBe(true)
    expect(saveButton(notice, 'ready')).toEqual({ text: 'Save', busy: false, disabled: false })
    expect(progressText(notice)).toBeNull()
    // Its offer is worked out from the document as it is, so an edit keeps it;
    // a smaller copy worked out for a failed press is dropped.
    expect(saveReducer(notice, { type: 'documentChanged' })).toBe(notice)
    const asked = run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'tooBig', failed: plan, why: 'a canvas that size came back blank', smaller }])
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
