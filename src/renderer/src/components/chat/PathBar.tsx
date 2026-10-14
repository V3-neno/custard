import { Fragment } from 'react'

// Plugins mode: where you are, and the way back. Plugins › Spotify › a chat.
// Each part but the last goes back there.

export type Crumb = { label: string; onClick?: () => void; title?: string }

function PathBar({ crumbs }: { crumbs: Crumb[] }): React.JSX.Element {
  return (
    <nav
      aria-label="Where you are"
      className="mx-auto flex w-full max-w-4xl min-w-0 items-center gap-1.5 px-6 pt-4 text-xs text-ash-500"
    >
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden>›</span>}
          {c.onClick && i < crumbs.length - 1 ? (
            <button
              onClick={c.onClick}
              title={c.title}
              className="shrink-0 rounded-full px-1.5 py-0.5 text-ash-400 transition-colors hover:bg-forge-850 hover:text-molten-200"
            >
              {c.label}
            </button>
          ) : (
            <span
              title={c.title}
              aria-current={i === crumbs.length - 1 ? 'location' : undefined}
              className={`min-w-0 truncate px-1.5 ${i === crumbs.length - 1 ? 'text-ash-300' : ''}`}
            >
              {c.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  )
}

export default PathBar
