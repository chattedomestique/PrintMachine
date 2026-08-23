import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './styles/index.css'
import App from './App.tsx'

// The build owns the service worker (playbook N1). autoUpdate + immediate
// means an installed client silently picks up a redeploy — no update-prompt UI.
registerSW({ immediate: true })

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
