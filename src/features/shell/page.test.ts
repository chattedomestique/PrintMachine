/**
 * Save's side of the page: the canvases the press is handed, and the file
 * handed over by a share sheet that never falls back to a download where that
 * would take the app with it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { planPrint } from '../../engine/export.ts'
import { defaultSettings, makeMedia } from '../../state/defaults.ts'
import { deliverFile, detachedCanvas, saveMessage } from './page.ts'

describe('handing the file over', () => {
  afterEach(() => vi.unstubAllGlobals())
  const file = () => new File([new Uint8Array(10)], 'print-machine.jpg', { type: 'image/jpeg' })
  /** A share sheet that behaves as told, and a page that records downloads. */
  const browser = (share: () => Promise<void>) => {
    const downloads: string[] = []
    vi.stubGlobal('navigator', { canShare: () => true, share })
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => downloads.push('a'), remove: () => {} }),
      body: { appendChild: () => {} },
    })
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    return downloads
  }
  const fail = (name: string) => async () => {
    const e = new Error(name)
    e.name = name
    throw e
  }

  it('shares; a dismissed sheet is a cancel, not an error', async () => {
    browser(async () => {})
    await expect(deliverFile(file(), { allowDownload: true })).resolves.toBe('shared')
    browser(fail('AbortError'))
    await expect(deliverFile(file(), { allowDownload: true })).resolves.toBe('cancelled')
  })

  it('in a home-screen app a failed share never falls through to a download: it throws, and the file waits for another tap', async () => {
    const downloads = browser(fail('DataError'))
    await expect(deliverFile(file(), { allowDownload: false })).rejects.toThrow('DataError')
    expect(downloads).toEqual([])
  })

  it('an expired tap asks for another tap, even where downloads are allowed', async () => {
    const downloads = browser(fail('NotAllowedError'))
    await expect(deliverFile(file(), { allowDownload: true })).rejects.toThrow('NotAllowedError')
    expect(downloads).toEqual([])
  })

  it('in a browser tab a failed share downloads instead, as before', async () => {
    const downloads = browser(fail('DataError'))
    await expect(deliverFile(file(), { allowDownload: true })).resolves.toBe('downloaded')
    expect(downloads).toEqual(['a'])
  })
})

describe('the confirmation', () => {
  it('repeats the dimensions, and a smaller copy says it is one', () => {
    const s = { ...defaultSettings(), aspect: '4:5' as const, media: makeMedia({ id: 'p', width: 4032, height: 3024, native: true }) }
    const p = planPrint(s)
    expect(saveMessage('shared', p)).toBe('Saved 2419×3024')
    expect(saveMessage('downloaded', p)).toBe('Downloaded 2419×3024')
    expect(saveMessage('cancelled', p)).toBeNull()
    // The caption above Save names the full size.
    expect(saveMessage('shared', planPrint(s, { maxHeight: 2268 }))).toBe('Saved 1814×2268, a smaller copy')
  })
})

describe("the press's canvases", () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a detached canvas, read from often; a page with no 2D context says so', () => {
    const asked: unknown[] = []
    const ctx = { canvas: {} }
    vi.stubGlobal('document', { createElement: (tag: string) => ({ tag, getContext: (kind: string, opts: unknown) => (asked.push([tag, kind, opts]), ctx) }) })
    expect(detachedCanvas()).toBe(ctx)
    expect(asked).toEqual([['canvas', '2d', { willReadFrequently: true }]])
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) })
    expect(() => detachedCanvas()).toThrow('Could not open a canvas to press the print.')
  })
})
