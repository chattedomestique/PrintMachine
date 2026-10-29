// Types for face-checks.mjs, which faces.test.ts imports.
export const POSTER_FAMILY: string
export const FACE_WAIT_MS: number
export const POSTER_FALLBACK: string
export const LOWERCASE_MAX: number
export function measureFaces(probe: { fonts: string[]; chars: string[]; text: string }): Promise<{ font: string; set: string; ascents: Record<string, number>; advance: number }[]>
export function lowercaseVerdict(ascent: (ch: string) => number): { ratio: number; ok: boolean }
export function faceSetsStack(withFace: number, without: number): boolean
