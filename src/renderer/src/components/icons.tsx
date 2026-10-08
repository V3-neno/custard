// Small stroke icons, sized by font size and colored by currentColor.
type IconProps = { className?: string }

const base = {
  width: '1em',
  height: '1em',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

export const HistoryIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...base} className={className}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const SettingsIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
)

export const PlusIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...base} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const ArrowUpIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...base} strokeWidth={2.2} className={className}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)

export const StopIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...base} className={className}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </svg>
)

export const CloseIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...base} className={className}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

// A dashed circle: a chat that leaves nothing behind.
export const TemporaryIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...base} className={className}>
    <circle cx="12" cy="12" r="8" strokeDasharray="3.2 3.2" />
  </svg>
)

export const VaultIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...base} className={className}>
    <path d="M12 2 4 6v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-4z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
)

export const PaperclipIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...base} className={className}>
    <path d="M21 11.5 12.4 20a5.5 5.5 0 0 1-7.8-7.8l8.9-8.8a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.8a1.8 1.8 0 0 1-2.6-2.6l8.2-8.1" />
  </svg>
)
