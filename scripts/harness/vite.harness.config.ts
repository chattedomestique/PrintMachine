import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Serves the render harness. Root is this folder; the app's `src/` is two
 * levels up, so the file server is allowed to read the repo. No React plugin:
 * the harness imports the engine and the document model only.
 *
 * `run.mjs` passes `cacheDir` so two checkouts of the repo (a commit and its
 * parent, for an A/B) never share a dependency cache.
 */
const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  logLevel: 'warn',
  server: {
    host: '127.0.0.1',
    fs: { allow: [resolve(here, '../..')] },
  },
})
