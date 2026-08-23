import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// One source of truth for the base path (playbook §3.5). GitHub Pages serves
// this repo from /PrintMachine/, dev serves from /. Every base-aware thing
// below — manifest id/start_url/scope, icon srcs, navigateFallback — derives
// from this constant rather than hard-coding a path.
const base = process.env.PAGES ? '/PrintMachine/' : '/'

// Must equal the light-scheme <meta name="theme-color"> in index.html (§3.1).
const THEME_COLOR = '#EDEDEC'

export default defineConfig({
  base,
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
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
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
  },
})
