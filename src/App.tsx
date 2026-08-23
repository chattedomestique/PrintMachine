import { SettingsProvider } from './state/SettingsContext.tsx'
import AppShell from './features/shell/AppShell.tsx'

export default function App() {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  )
}
