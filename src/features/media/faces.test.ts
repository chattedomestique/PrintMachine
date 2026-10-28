/**
 * The bundled face's loading (faces.ts), and the verdicts verify-offline.mjs
 * passes on it in the browser (scripts/face-checks.mjs), each shown failing
 * where it must.
 */

import { describe, expect, it } from 'vitest'
import { FACE_WAIT_MS, POSTER_FAMILY, faceGeneration, loadFaces, onFaceLanded, type FaceLoader } from './faces.ts'
import { fontById } from '../../engine/types.ts'
import {
  FACE_WAIT_MS as CHECKED_WAIT_MS,
  LOWERCASE_MAX,
  POSTER_FALLBACK,
  POSTER_FAMILY as CHECKED_FAMILY,
  faceSetsStack,
  lowercaseVerdict,
} from '../../../scripts/face-checks.mjs'

/** A `document.fonts` whose load settles when the test says. */
function loader() {
  let settle: (faces: readonly { status: string }[]) => void = () => {}
  let fail: () => void = () => {}
  const asked: string[] = []
  const fonts: FaceLoader = {
    load: (font) => {
      asked.push(font)
      return new Promise((resolve, reject) => {
        settle = resolve
        fail = () => reject(new DOMException('network', 'NetworkError'))
      })
    },
  }
  return { fonts, asked, settle: (faces: readonly { status: string }[]) => settle(faces), fail: () => fail() }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('loadFaces', () => {
  it("asks for Poster's face and answers loaded once it is in, the generation unmoved", async () => {
    const l = loader()
    const before = faceGeneration()
    const outcome = loadFaces(l.fonts, 1000)
    expect(l.asked).toEqual([`40px ${POSTER_FAMILY}`])
    l.settle([{ status: 'loaded' }])
    expect(await outcome).toBe('loaded')
    expect(faceGeneration()).toBe(before)
  })

  it('answers failed when no face is declared (load resolves with none), when one errors, and when the load rejects', async () => {
    for (const end of [(l: ReturnType<typeof loader>) => l.settle([]), (l: ReturnType<typeof loader>) => l.settle([{ status: 'error' }]), (l: ReturnType<typeof loader>) => l.fail()]) {
      const l = loader()
      const outcome = loadFaces(l.fonts, 1000)
      end(l)
      expect(await outcome).toBe('failed')
    }
    expect(await loadFaces(undefined)).toBe('failed')
    const throwing: FaceLoader = {
      load: () => {
        throw new DOMException('bad font', 'SyntaxError')
      },
    }
    expect(await loadFaces(throwing, 1000)).toBe('failed')
  })

  it('goes on without a slow face, and moves the generation when it lands, once, telling each listener', async () => {
    const l = loader()
    const before = faceGeneration()
    let told = 0
    const stop = onFaceLanded(() => told++)
    expect(await loadFaces(l.fonts, 5)).toBe('late')
    expect(faceGeneration()).toBe(before)
    l.settle([{ status: 'loaded' }])
    await tick()
    expect(faceGeneration()).toBe(before + 1)
    expect(told).toBe(1)
    stop()
  })

  it('a slow face that then fails moves nothing: what was set in the fallback stays', async () => {
    const l = loader()
    const before = faceGeneration()
    let told = 0
    const stop = onFaceLanded(() => told++)
    expect(await loadFaces(l.fonts, 5)).toBe('late')
    l.fail()
    await tick()
    expect(faceGeneration()).toBe(before)
    expect(told).toBe(0)
    stop()
  })

  it('waits two seconds at most by default, as long as verify-offline gives the app to mount', () => {
    expect(FACE_WAIT_MS).toBe(2000)
    expect(CHECKED_WAIT_MS).toBe(FACE_WAIT_MS)
  })
})

describe("verify-offline's verdicts on the face (scripts/face-checks.mjs)", () => {
  it("names the face and the stack the app sets: Poster's stack is the face, then the fallback the check measures against", () => {
    expect(CHECKED_FAMILY).toBe(POSTER_FAMILY)
    expect(fontById('poster').stack).toBe(`${POSTER_FAMILY}, ${POSTER_FALLBACK}`)
  })

  it("passes Tanklager's lowercase (o at 0.68 of O)", () => {
    const v = lowercaseVerdict((ch: string) => ({ o: 19.04, O: 28 })[ch] ?? 0)
    expect(v.ratio).toBeCloseTo(0.68, 2)
    expect(v.ok).toBe(true)
  })

  it('fails a face whose lowercase is its capitals (o as tall as O), and one just over the bound', () => {
    expect(lowercaseVerdict(() => 28).ok).toBe(false)
    expect(lowercaseVerdict((ch: string) => (ch === 'o' ? 28 * (LOWERCASE_MAX + 0.01) : 28)).ok).toBe(false)
    expect(lowercaseVerdict((ch: string) => (ch === 'o' ? 28 * LOWERCASE_MAX : 28)).ok).toBe(true)
  })

  it('fails ink it could not measure', () => {
    expect(lowercaseVerdict(() => 0).ok).toBe(false)
    expect(lowercaseVerdict((ch: string) => (ch === 'o' ? 10 : 0)).ok).toBe(false)
  })

  it('the face sets the stack only when its advance differs from the fallback: an unloaded face measures as the fallback and fails', () => {
    expect(faceSetsStack(412.5, 470.25)).toBe(true)
    expect(faceSetsStack(470.25, 470.25)).toBe(false)
    expect(faceSetsStack(Number.NaN, 470.25)).toBe(false)
  })
})
