import { useRef } from 'react'

// A short, fixed choice (two to five short labels) as a row of pills, in the
// look of the effort row in the chat box's model picker
// (docs/ui-dropdowns.md). A radio group: one Tab stop, the arrow keys move
// and pick, Home and End jump to the ends.

export type Pill<T extends string> = { value: T; label: string }

type Props<T extends string> = {
  options: Pill<T>[]
  // Nothing is picked when the value matches no option.
  value: T | undefined
  onChange: (value: T) => void
  label: string
  disabled?: boolean
  className?: string
}

export default function PillGroup<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
  className = ''
}: Props<T>): React.JSX.Element {
  const row = useRef<HTMLDivElement>(null)
  const picked = options.findIndex((o) => o.value === value)
  // The pill Tab lands on: the picked one, else the first.
  const stop = picked >= 0 ? picked : 0

  const move = (e: React.KeyboardEvent, from: number): void => {
    const last = options.length - 1
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? from === last
          ? 0
          : from + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? from === 0
            ? last
            : from - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (to === null) return
    e.preventDefault()
    onChange(options[to].value)
    row.current?.querySelectorAll<HTMLButtonElement>('[role=radio]')[to]?.focus()
  }

  return (
    <div
      ref={row}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={`flex gap-1 ${className}`}
    >
      {options.map((o, i) => {
        const on = i === picked
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={o.value}
            disabled={disabled}
            tabIndex={i === stop ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
            className={`focus-ring flex-1 rounded-full border px-1.5 py-1 text-xs disabled:opacity-40 ${
              on
                ? 'border-molten-500/60 text-molten-200'
                : 'border-forge-700 text-ash-300 hover:text-molten-200'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
