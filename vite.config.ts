import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'

// One source of truth for the base path (playbook §3.5). GitHub Pages serves
// this repo from /PrintMachine/, dev serves from /. Every base-aware thing
// below — manifest id/start_url/scope, icon srcs, navigateFallback — derives
// from this constant rather than hard-coding a path.
const base = process.env.PAGES ? '/PrintMachine/' : '/'

// Must equal the light-scheme <meta name="theme-color"> in index.html (§3.1):
// the style guide's --canvas in its `default` palette, oklch(0.97 0 95),
// resolved in a browser (the dark one is oklch(0.165 0 95), #0E0E0E). Change
// them together with data-palette.
const THEME_COLOR = '#F5F5F5'

// The build stamp (Border Studio's, vite.config.js): the commit and the day
// this build was made, shown in the More sheet's offline row, so which
// version is running is never a guess. An installed app updates itself in
// place, with nothing else to say it did.
let sha = 'dev'
try {
  sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {
  // Not a git checkout: the stamp says 'dev'.
}
const BUILD_ID = `${sha} · ${new Date().toISOString().slice(0, 10)}`

export default defineConfig({
  base,
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: base,
        name: 'Print Machine',
        short_name: 'Print',
        description: 'Turn type into an authentic Risograph print, on your phone.',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        theme_color: THEME_COLOR,
        background_color: THEME_COLOR,
        icons: [
          { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `${base}maskable-192.png`, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: `${base}maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // woff: Poster's bundled face (src/styles/fonts.css); woff2: the
        // style guide's Archivo. Both precached, so the print and the chrome
        // are set in their own faces offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        // Base-aware — this is the one that breaks offline only on Pages (§3.5).
        navigateFallback: `${base}index.html`,
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/vitest.setup.ts'],
  },
})
