type Props = { size?: number; state?: 'idle' | 'active' | 'thinking'; className?: string }

// A glowing molten orb: Custard's mark, and its "thinking" indicator while
// Claude works. Faster swirl and pulse when thinking.
function Orb({ size = 20, state = 'active', className = '' }: Props): React.JSX.Element {
  return (
    <div
      className={`orb ${className}`}
      data-state={state}
      style={{ width: size, height: size, ['--orb-size' as string]: `${size}px` }}
      aria-hidden
    >
      <span className="orb-base" />
      <span className="orb-swirl" />
      <span className="orb-core" />
      <span className="orb-shine" />
    </div>
  )
}

export default Orb
