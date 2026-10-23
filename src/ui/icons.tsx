/** Lean linear icons, one per tool. Decorative — every consumer supplies its
 *  own accessible name, so these are all aria-hidden. */

type IconProps = { size?: number }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
})

export const UndoIcon = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 10h10a5 5 0 0 1 0 10h-4" />
    <path d="m8 6-4 4 4 4" />
  </svg>
)

export const RedoIcon = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M20 10H10a5 5 0 0 0 0 10h4" />
    <path d="m16 6 4 4-4 4" />
  </svg>
)

export const PlusIcon = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const TrashIcon = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </svg>
)
