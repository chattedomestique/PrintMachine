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
import { afterEach } from 'vitest'

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))
