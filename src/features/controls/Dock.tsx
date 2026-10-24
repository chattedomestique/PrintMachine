import type { ReactNode } from 'react'
import { Tabs, type TabItem } from '../../ui/ui.tsx'

/**
 * Every panel is the same two parts at the same heights (editor.css): a head
 * row (the plate button, for Type and Ink, then the tabs) and the content area
 * under it: an options row at the top and the parameter strip at the bottom.
 * The content area is one height in every panel, so the sheet above never
 * changes size when you switch tools or tabs, and the slider is always in the
 * same place under your thumb (Border Studio's DockPanel).
 *
 * `data-tool` and `data-sub` are the DOM contract scripts/verify-geometry.mjs
 * reads.
 */
export function DockPanel<T extends string>({
  tool,
  label,
  lead,
  tabs,
  sub,
  onSub,
  children,
}: {
  tool: string
  label: string
  lead?: ReactNode
  tabs: readonly TabItem<T>[]
  sub: T
  onSub: (sub: T) => void
  children: ReactNode
}) {
  const idBase = `dock-${tool}`
  return (
    <section className="controls__section" data-tool={tool} aria-label={label}>
      <div className="controls__head">
        {lead}
        <Tabs label={label} tabs={tabs} value={sub} onChange={onSub} idBase={idBase} />
      </div>
      <div
        role="tabpanel"
        id={`${idBase}-panel`}
        aria-labelledby={`${idBase}-tab-${sub}`}
        className="controls__panel"
        data-sub={sub}
      >
        {children}
      </div>
    </section>
  )
}

/** Nothing to set yet: one line in the middle of the content area, and the
 *  one action that changes that. */
export function DockEmpty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="controls__empty">
      <p>{children}</p>
      {action}
    </div>
  )
}

/** The hairline between two settings (decoration: the rows are already
 *  separate controls to a screen reader). */
export function Rule() {
  return <div className="controls__rule" aria-hidden="true" />
}
