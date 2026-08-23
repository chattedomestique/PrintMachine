import { useRef, useState } from 'react'
import TypePanel from './TypePanel.tsx'
import InkPanel from './InkPanel.tsx'
import PressPanel from './PressPanel.tsx'
import PaperPanel from './PaperPanel.tsx'
import './Controls.css'

const TABS = [
  { id: 'type', label: 'Type' },
  { id: 'ink', label: 'Ink' },
  { id: 'press', label: 'Press' },
  { id: 'paper', label: 'Paper' },
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * Progressive disclosure: the controls for a thing don't exist until you ask
 * for that thing. Tapping the active tab collapses the drawer entirely, which
 * is how you get the print back to full size on a phone.
 */
export default function Controls() {
  const [tab, setTab] = useState<TabId>('type')
  const [open, setOpen] = useState(true)
  const panelRef = useRef<HTMLDivElement>(null)

  const select = (id: TabId) => {
    if (id === tab) {
      setOpen((v) => !v)
      return
    }
    setTab(id)
    setOpen(true)
    // Move focus into the panel that just opened (playbook §10.1).
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
    })
  }

  return (
    <section className="controls" aria-label="Print controls">
      <div className="tabs" role="tablist" aria-label="Control groups">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls={`panel-${t.id}`}
            aria-expanded={t.id === tab && open}
            tabIndex={t.id === tab ? 0 : -1}
            className="tab"
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="drawer" data-open={open}>
        <div
          className="drawer-inner"
          ref={panelRef}
          id={`panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          inert={!open ? true : undefined}
        >
          {tab === 'type' && <TypePanel />}
          {tab === 'ink' && <InkPanel />}
          {tab === 'press' && <PressPanel />}
          {tab === 'paper' && <PaperPanel />}
        </div>
      </div>
    </section>
  )
}
