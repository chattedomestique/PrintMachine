/**
 * After every test, one turn of the event loop.
 *
 * A vitest worker reports each test's progress to the main process and
 * waits at most 60 s for the answer, which it can only read when its event
 * loop turns. Tests that compute synchronously, one after another, never
 * turn it: a file of them that runs past 60 s fails `npm test` with
 * "[vitest-worker]: Timeout calling "onTaskUpdate"" although every test
 * passed (banded.test.ts runs 64 to 69 s; seen once in a replay of CI under
 * Node 20). `setImmediate` resolves after the loop's poll phase, where the
 * answers are read, so a report is never older than one test.
 */
import { afterEach, vi } from 'vitest'

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))

/**
 * Each test's limit, unless it names its own: 15 s.
 *
 * Vitest's own 5 s sits within 2x of what several pressing tests typically
 * take on a 4-core machine, so a loaded runner turned one red for no change.
 * 15 s is 3x the slowest test that has no limit of its own; the heaviest name
 * theirs. Set here, the runner's own setup file, rather than in
 * vite.config.ts, whose diff from the app before the frame stays the
 * precache's patterns, the manifest's description and the build stamp.
 */
vi.setConfig({ testTimeout: 15_000 })
