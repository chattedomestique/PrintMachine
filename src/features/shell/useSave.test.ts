/**
 * The save flow as a pure state machine: a press that outlasts its tap waits
 * for a fresh one, Cancel works while it presses, a failed share keeps the
 * file, the preview pauses, Save waits for the document's photo, and a print
 * too big for the device, or a save the app died during, is put as a question
 * in numbers.
 */

import { describe, expect, it } from 'vitest'

import { CanvasLimitError, MissingPhotoError, planPrint } from '../../engine/export.ts'
import { planExport } from '../../engine/exportPlan.ts'
import type { PrintSettings } from '../../engine/types.ts'
import { defaultSettings, makeMedia } from '../../state/defaults.ts'
import { PhotoDecodeError } from '../media/decode.ts'
import {
  IDLE,
  SHARE_AT_ONCE_MS,
  canStart,
  copyRect,
  pressForSave,
  type SaveDeps,
  moreCaption,
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
const plan = planExport({ aspect: 4 / 5 }, photo)
const planAt = (maxHeight: number) => planExport({ aspect: 4 / 5 }, photo, { maxHeight })
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
        { type: 'progress', progress: { step: 'press', band: 0, bands: 6 } },
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
    // The More sheet promises no size either: its first row says why, and
    // the PNG row has no size to show.
    const native = { size: '3024×4032', reason: null }
    const zoomed = { size: '2400×1800', reason: 'photo is 1600×1200 at 300% zoom: upscaled 4.5x' }
    for (const c of [native, zoomed]) {
      expect(moreCaption('failed', c, true)).toStrictEqual({
        size: null,
        word: why,
        meta: 'Nothing is saved without it: never the type on bare paper.',
        alert: true,
      })
    }
  })

  it('the More sheet\'s first row: the size a save makes, and why when it is not the photo\'s own pixels', () => {
    const native = { size: '3024×4032', reason: null }
    const zoomed = { size: '2400×1800', reason: 'photo is 1600×1200 at 300% zoom: upscaled 4.5x' }
    expect(moreCaption('ready', native, true)).toStrictEqual({
      size: '3024×4032',
      word: 'Saves 3024×4032',
      meta: "The photo's own pixels, one for one.",
      alert: false,
    })
    expect(moreCaption('ready', zoomed, true)).toStrictEqual({ size: '2400×1800', word: 'Saves 2400×1800', meta: zoomed.reason, alert: false })
    // While the photo decodes the plan is already known (the layer's own
    // dimensions): the size stands.
    expect(moreCaption('loading', native, true).size).toBe('3024×4032')
    expect(moreCaption('none', { size: '2880×3600', reason: null }, false)).toStrictEqual({
      size: '2880×3600',
      word: 'Saves 2880×3600',
      meta: 'No photo: type on bare paper.',
      alert: false,
    })
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
      { type: 'progress', progress: { step: 'press', band: 1, bands: 6 } },
    ])
    expect(saveStatus(pressing, 'none')).toEqual({ text: 'Pressing 3024×3780, 16%', alert: false, busy: true, action: 'cancel' })
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

  it('says how far the press has got: in pixels, and in percent of its bands', () => {
    const start = run([{ type: 'start', format: 'jpeg', plan, photo: true }])
    expect(progressText(start)).toBe('Pressing 3024×3780: loading the photo')
    // Before its first step a press claims nothing; then the photo read for
    // the second ink, the bands, and the file.
    expect(progressText(run([{ type: 'start', format: 'jpeg', plan, photo: false }]))).toBe('Pressing 3024×3780')
    expect(progressText(run([{ type: 'photoLoaded' }, { type: 'progress', progress: { step: 'photo', band: 2, bands: 6 } }], start))).toBe(
      'Pressing 3024×3780: reading the photo',
    )
    const at = (band: number, bands: number) =>
      progressText(run([{ type: 'photoLoaded' }, { type: 'progress', progress: { step: 'press', band, bands } }], start))
    expect(at(0, 6)).toBe('Pressing 3024×3780, 0%')
    expect(at(3, 7)).toBe('Pressing 3024×3780, 42%')
    expect(at(19, 20)).toBe('Pressing 3024×3780, 95%')
    const pressing = run([{ type: 'photoLoaded' }, { type: 'progress', progress: { step: 'press', band: 2, bands: 6 } }], start)
    expect(saveButton(pressing, 'ready')).toEqual({ text: 'Saving', busy: true, disabled: true })
    expect(saveLabel(pressing, 'ready', '3024×3780')).toBe('Saving 3024×3780')
    expect(progressText(saveReducer(pressing, { type: 'progress', progress: { step: 'write', band: 6, bands: 6 } }))).toBe(
      'Pressing 3024×3780: writing the file',
    )
    expect(progressText(IDLE)).toBeNull()
  })
})

describe('a print too big for this device, and a save that did not finish', () => {
  const smaller = planAt(2835)

  it('a press that fails for size asks about a smaller copy; it never starts one by itself', () => {
    const pressing = run([{ type: 'start', format: 'png', plan, photo: true }, { type: 'photoLoaded' }])
    const asked = saveReducer(pressing, { type: 'tooBig', failed: plan, why: 'a canvas came back blank', smaller })
    expect(asked).toEqual({ kind: 'tooBig', format: 'png', failed: plan, why: 'a canvas came back blank', smaller })
    expect(pressInProgress(asked)).toBe(false)
    expect(saveQuestion(asked, planAt)).toEqual({
      title: 'Too big for this device',
      text: "This device couldn't press 3024×3780 (a canvas came back blank). Save a smaller 2268×2835 copy instead?",
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
    expect(saveReducer(IDLE, { type: 'tooBig', failed: plan, why: 'a canvas came back blank', smaller })).toBe(IDLE)
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
    const asked = run([{ type: 'start', format: 'jpeg', plan, photo: false }, { type: 'tooBig', failed: plan, why: 'a canvas came back blank', smaller }])
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

describe('the press behind Save: the photo decoded as the print needs it, and what a device cannot press', () => {
  const doc = (width: number, height: number, aspect: PrintSettings['aspect'] = '4:5'): PrintSettings => ({
    ...defaultSettings(),
    aspect,
    media: makeMedia({ id: 'photo', width, height, native: true }),
  })
  const bitmap = (width: number, height: number) => {
    const b = { width, height, closed: 0, close: () => b.closed++ }
    return b
  }
  /** The page's deps, recorded: every decode asked for, every press made. */
  const deps = (over: Partial<SaveDeps> = {}) => {
    const log = {
      full: [] as string[],
      resized: [] as string[],
      pressed: [] as Parameters<SaveDeps['savePrint']>[2][],
      canvases: [] as string[],
      bitmaps: [] as ReturnType<typeof bitmap>[],
    }
    const d: SaveDeps = {
      decodeOriginal: async (id) => {
        log.full.push(id)
        const b = bitmap(4032, 3024)
        log.bitmaps.push(b)
        return b as unknown as ImageBitmap
      },
      decodeResized: async (id, w, h) => {
        log.resized.push(`${id} ${w}x${h}`)
        const b = bitmap(w, h)
        log.bitmaps.push(b)
        return b as unknown as ImageBitmap
      },
      savePrint: async (settings, _media, opts) => {
        log.pressed.push(opts)
        const p = planPrint(settings, { maxHeight: opts?.maxHeight, format: opts?.format })
        opts?.onGround?.()
        return { blob: new Blob([new Uint8Array(10)]), plan: p, format: opts?.format ?? 'jpeg' }
      },
      makeCanvas: () => ({}) as CanvasRenderingContext2D,
      canvasFits: (w, h) => (log.canvases.push(`${w}x${h}`), true),
      ...over,
    }
    return { d, log }
  }

  it('a print at its own pixels decodes the original, presses it, and closes it', async () => {
    const { d, log } = deps()
    let loaded = 0
    const r = await pressForSave({ settings: doc(4032, 3024), format: 'jpeg', onPhotoLoaded: () => loaded++ }, d)
    expect(r.kind).toBe('pressed')
    expect(log.full).toEqual(['photo'])
    expect(log.resized).toEqual([])
    expect(loaded).toBe(1)
    expect(log.pressed[0]).toMatchObject({ format: 'jpeg', rect: undefined })
    // On the page's canvases: the engine makes none of its own.
    expect(log.pressed[0]!.makeCanvas).toBe(d.makeCanvas)
    expect(log.bitmaps.every((b) => b.closed >= 1)).toBe(true)
  })

  it('a smaller copy decodes the photo straight to its integer rectangle and presses it there, 1:1', async () => {
    const { d, log } = deps()
    const s = doc(4032, 3024)
    const plan = planPrint(s, { maxHeight: 2268 })
    expect(plan).toMatchObject({ width: 1814, height: 2268, limit: 'smaller' })
    const r = await pressForSave({ settings: s, format: 'jpeg', maxHeight: 2268 }, d)
    expect(r.kind).toBe('pressed')
    expect(log.full).toEqual([])
    // The cover fit of 4032x3024 on 1814x2268 is 3024 x 2268 (a scale of
    // 0.75, dx -605): already whole, so it is the rectangle as it is.
    const rect = copyRect(s, plan)!
    expect(rect).toEqual({ dx: -605, dy: 0, dw: 3024, dh: 2268 })
    expect(log.resized).toEqual(['photo 3024x2268'])
    expect(log.pressed[0]).toMatchObject({ maxHeight: 2268, rect })
    // A fractional fit is rounded up and placed on whole pixels, still
    // covering the sheet.
    const p = planPrint(doc(4000, 3001), { maxHeight: 1999 })
    const odd = copyRect(doc(4000, 3001), p)!
    expect([odd.dx, odd.dy, odd.dw, odd.dh].every(Number.isInteger)).toBe(true)
    expect(odd.dx <= 0 && odd.dy <= 0 && odd.dx + odd.dw >= p.width && odd.dy + odd.dh >= p.height).toBe(true)
  })

  it('a whole decode that fails while a smaller one works is this device\'s size: the largest copy whose canvases and photo it can hold', async () => {
    const reason = 'Cannot create an image buffer from the argument to createImageBitmap'
    const { d, log } = deps({
      decodeOriginal: async () => {
        throw new PhotoDecodeError(reason)
      },
    })
    const r = await pressForSave({ settings: doc(7728, 5152, 'original'), format: 'jpeg' }, d)
    expect(r).toMatchObject({ kind: 'tooBig', why: reason, failed: { width: 7728, height: 5152 }, smaller: { width: 5796, height: 3864, limit: 'smaller' } })
    // The copy's canvases (its first tile, its photo's band), then its photo
    // at its size: one decode.
    expect(log.canvases).toEqual(['4096x1024', '4096x361'])
    expect(log.resized).toEqual(['photo 5796x3864'])
    expect(log.pressed).toEqual([])
  })

  it('a file that cannot be decoded at any size stays a plain failure, never a smaller-copy offer', async () => {
    const { d, log } = deps({
      decodeOriginal: async () => {
        throw new PhotoDecodeError('The source image could not be decoded.')
      },
      decodeResized: async () => {
        throw new PhotoDecodeError('The source image could not be decoded.')
      },
    })
    await expect(pressForSave({ settings: doc(4032, 3024), format: 'jpeg' }, d)).rejects.toThrow(
      'The photo could not be decoded to save: The source image could not be decoded.',
    )
    expect(log.pressed).toEqual([])
  })

  it('a canvas that comes back blank: the largest copy that proves itself, its photo decoded only for the one offered', async () => {
    const s = doc(4032, 3024)
    const { d, log } = deps({
      savePrint: async () => {
        throw new CanvasLimitError(planPrint(s), 'a canvas came back blank')
      },
    })
    // Canvases wider than 1500 px read back blank.
    d.canvasFits = (w, h) => (log.canvases.push(`${w}x${h}`), w <= 1500)
    const r = await pressForSave({ settings: s, format: 'png' }, d)
    // 2268 tall (its tile 1814 wide: blank), then 1701 (1361 wide: fits).
    expect(r).toMatchObject({ kind: 'tooBig', why: 'a canvas came back blank', smaller: { width: 1361, height: 1701 } })
    expect(log.canvases).toEqual(['1814x2268', '1361x1701', '1361x1540'])
    expect(log.resized).toEqual(['photo 2268x1701'])
    expect(log.bitmaps.every((b) => b.closed >= 1)).toBe(true)
  })

  it('a missing photo is said as itself, and a Cancel while it decodes stops before the press', async () => {
    const { d } = deps({
      decodeOriginal: async () => {
        throw new MissingPhotoError()
      },
    })
    await expect(pressForSave({ settings: doc(4032, 3024), format: 'jpeg' }, d)).rejects.toBeInstanceOf(MissingPhotoError)
    const controller = new AbortController()
    const { d: d2, log } = deps({
      decodeOriginal: async () => {
        controller.abort()
        return bitmap(4032, 3024) as unknown as ImageBitmap
      },
    })
    await expect(pressForSave({ settings: doc(4032, 3024), format: 'jpeg', signal: controller.signal }, d2)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(log.pressed).toEqual([])
  })

  it('a Cancel tapped while the smaller copies are probed is a cancel, never the question afterwards', async () => {
    // Each probe may decode the photo at the copy's size: the person taps
    // Cancel during the first one. After a press that failed for size, and
    // after a whole decode that failed.
    const s = doc(4032, 3024)
    for (const failure of ['press', 'decode'] as const) {
      const controller = new AbortController()
      let tapped = false
      const { d, log } = deps({
        savePrint: async () => {
          throw new CanvasLimitError(planPrint(s), 'a canvas came back blank')
        },
      })
      if (failure === 'decode') {
        d.decodeOriginal = async () => {
          throw new PhotoDecodeError('Cannot create an image buffer')
        }
      }
      const probe = d.decodeResized
      d.decodeResized = async (id, w, h) => {
        const b = await probe(id, w, h)
        if (tapped) controller.abort()
        return b
      }
      // Without the Cancel the first candidate proves itself and is offered.
      expect(await pressForSave({ settings: s, format: 'jpeg', signal: controller.signal }, d), failure).toMatchObject({
        kind: 'tooBig',
        smaller: { width: 1814, height: 2268 },
      })
      log.resized.length = 0
      tapped = true
      await expect(pressForSave({ settings: s, format: 'jpeg', signal: controller.signal }, d), failure).rejects.toMatchObject({
        name: 'AbortError',
      })
      // One probe, the one the Cancel landed in: none after it.
      expect(log.resized, failure).toEqual(['photo 3024x2268'])
      expect(log.bitmaps.every((b) => b.closed >= 1), failure).toBe(true)
    }
  })
})
