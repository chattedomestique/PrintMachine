/**
 * Every typed array made while a piece of code runs, for the tests that hold
 * the press and the encoders to "allocate once": the constructors are wrapped
 * as scripts/measure-alloc.mjs wraps them, and a view over an existing buffer
 * (`subarray`, `new X(buffer, ...)`) is not counted, since it allocates
 * nothing. Each entry names its buffer, so a test can tell an array the code
 * hands on (a chunk of a file) from one it keeps or drops.
 */

type Ctor = new (...args: unknown[]) => ArrayBufferView & { byteLength: number; buffer: ArrayBufferLike }

const NAMES = ['Float32Array', 'Float64Array', 'Uint8Array', 'Uint8ClampedArray', 'Int32Array', 'Uint32Array', 'Uint16Array', 'Int16Array'] as const

export interface Allocation {
  bytes: number
  buffer: ArrayBufferLike
  /** The `phase.now` at the time it was made. */
  phase: string
}

function install(log: Allocation[], phase: { now: string }): () => void {
  const g = globalThis as unknown as Record<string, Ctor>
  const saved = NAMES.map((n) => [n, g[n]] as const)
  for (const [name, Orig] of saved) {
    g[name] = class extends Orig {
      constructor(...args: unknown[]) {
        super(...args)
        if (!(args[0] instanceof ArrayBuffer)) log.push({ bytes: this.byteLength, buffer: this.buffer, phase: phase.now })
      }
      static [Symbol.hasInstance](x: unknown) {
        return x instanceof Orig
      }
    }
  }
  return () => {
    for (const [name, Orig] of saved) g[name] = Orig
  }
}

/** The arrays `run` makes; it sets `phase.now` to label them. */
export function allocations(run: (phase: { now: string }) => void): Allocation[] {
  const log: Allocation[] = []
  const phase = { now: 'setup' }
  const restore = install(log, phase)
  try {
    run(phase)
  } finally {
    restore()
  }
  return log
}

/** The same for code that awaits (the PNG encoder's stream). */
export async function allocationsAsync(run: (phase: { now: string }) => Promise<void>): Promise<Allocation[]> {
  const log: Allocation[] = []
  const phase = { now: 'setup' }
  const restore = install(log, phase)
  try {
    await run(phase)
  } finally {
    restore()
  }
  return log
}
