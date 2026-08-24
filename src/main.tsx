import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './styles/index.css'
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
    onOfflineReady: setOfflineReady,
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

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
