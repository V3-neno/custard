export type Mode = 'chat' | 'code' | 'design'

export const modes: { id: Mode; label: string; icon: string; blurb: string }[] = [
  { id: 'chat', label: 'Chat', icon: '💬', blurb: 'Normal conversations with Claude.' },
  {
    id: 'code',
    label: 'Code',
    icon: '⌨️',
    blurb: 'Claude Code working in a folder on this computer.'
  },
  {
    id: 'design',
    label: 'Design',
    icon: '🎨',
    blurb: 'Generate UI and preview it live, side by side.'
  }
]
