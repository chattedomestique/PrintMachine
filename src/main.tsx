import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
// The style guide first: core declares the layer order (sg.reset … sg.utilities)
// that everything after it slots into. Then only the elements the app uses
// (src/vendor/styleguide/VERSION.md; never edited here, see
// scripts/sync-styleguide.mjs).
import './vendor/styleguide/core.min.css'
import './vendor/styleguide/icons.css'
import './vendor/styleguide/elements/button.min.css'
import './vendor/styleguide/elements/card.min.css'
import './vendor/styleguide/elements/appbar.min.css'
import './vendor/styleguide/elements/toolbar.min.css'
import './vendor/styleguide/elements/tabs.min.css'
import './vendor/styleguide/elements/segmented.min.css'
import './vendor/styleguide/elements/slider.min.css'
import './vendor/styleguide/elements/swatch.min.css'
import './vendor/styleguide/elements/switch.min.css'
import './vendor/styleguide/elements/dialog.min.css'
import './vendor/styleguide/elements/input.min.css'
import './vendor/styleguide/elements/select.min.css'
import './vendor/styleguide/elements/spinner.min.css'
import './vendor/styleguide/elements/menu.min.css'
// The app's own CSS is unlayered, so it wins over every sg.* layer without
// !important. In this order: app facts, the editor's planes and type scale,
// the dock's panels, the shell.
import './styles/index.css'
import './styles/editor.css'
import './styles/dock.css'
import './styles/shell.css'
import App from './App.tsx'
import { setOfflineReady, setUnsupported } from './state/swStatus.ts'

// The build owns the service worker (playbook N1). autoUpdate + immediate
// means an installed client silently picks up a redeploy — no update-prompt UI.
//
// onOfflineReady fires once everything in the precache manifest is stored, so
// it is the only honest signal that this app will actually open without a
// network. Surfacing it matters on iOS, where a home-screen PWA must be
// launched once online before offline ever works.
if ('serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onOfflineReady: () => setOfflineReady(true),
    // An already-active worker means a previous visit finished precaching, so
    // this launch is offline-capable even though onOfflineReady won't re-fire.
    onRegisteredSW: (_url, registration) => {
      if (registration?.active) setOfflineReady()
    },
    onRegisterError: setUnsupported,
  })
} else {
  setUnsupported()
}

// The app bar stays one row with whole words (the style guide's rule 19).
// CSS cannot ask "does the title fit?", so the style guide's SG.fit measures
// it and writes the richest layout that fits to data-fit (shell.css draws
// each):
//   full     the title on one line, Save with its word
//   compact  Save as an icon (its name stays in aria-label)
//   tight    and the title may wrap at its space ("Print / Machine")
// It re-checks on resize, on the reader's text size and when fonts load.
//
// Vite hoists this module into <head>, ahead of the style guide's deferred
// scripts in <body>, so SG may not exist yet. Every deferred script has run by
// DOMContentLoaded, so register then if it is not already there.
const registerBarFit = () =>
  window.SG?.fit?.register('.app__bar', { steps: ['full', 'compact', 'tight'], parts: '.appbar__title', strict: true })
if (window.SG?.fit) registerBarFit()
else document.addEventListener('DOMContentLoaded', registerBarFit, { once: true })
// SG.fit re-checks when `document.fonts.ready` settles, and that can settle
// before Archivo is even asked for (the bar mounts after the scripts ran), so
// a launch from cache measured the title in the fallback face and kept the
// bar icon-only at 390 px (seen in the built app, about one load in ten).
// Re-check whenever a face finishes loading.
document.fonts?.addEventListener?.('loadingdone', () => window.SG?.fit?.update?.())

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
