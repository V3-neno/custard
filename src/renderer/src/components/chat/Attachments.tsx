import { useEffect, useState } from 'react'
import {
  formatBytes,
  kindLabel,
  type Attachment,
  type DraftAttachment
} from '../../../../shared/attachments'
import { providerNames, type Provider } from '../../../../shared/chat'

// Attached files: chips in the composer (picked, not sent yet) and the files
// on a sent message. Names are shown as plain text; images come from
// Custard's own copy as a size-bounded data URL.

function Thumb({
  where,
  a
}: {
  where: { chat?: string; draft?: string }
  a: Pick<Attachment, 'id' | 'ext' | 'mime' | 'kind' | 'missing'>
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const key = `${where.chat ?? where.draft}:${a.id}`
  useEffect(() => {
    let live = true
    if (a.kind === 'image')
      void window.custard.attachments.preview(where, a).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
    // The key covers where and which file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (url && !a.missing)
    return <img src={url} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-forge-950 text-[9px] font-semibold tracking-wide text-molten-300 uppercase">
      {a.kind === 'pdf' ? 'PDF' : a.kind === 'image' ? 'IMG' : a.ext.slice(0, 4) || 'TXT'}
    </span>
  )
}

const detail = (a: Omit<Attachment, 'message'>): string =>
  [
    kindLabel[a.kind],
    formatBytes(a.bytes),
    a.width && a.height ? `${a.width}×${a.height}` : '',
    a.frames && a.frames > 1 ? `${a.frames} frames` : '',
    a.pages ? `${a.pages} ${a.pages === 1 ? 'page' : 'pages'}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

// In the composer: what will go with the message, and what was refused.
export function DraftFiles({
  files,
  errors,
  onRemove,
  onDismiss,
  disabled
}: {
  files: DraftAttachment[]
  errors: { name: string; error: string }[]
  onRemove: (id: string) => void
  onDismiss: () => void
  disabled: boolean
}): React.JSX.Element | null {
  if (!files.length && !errors.length) return null
  return (
    <div className="mb-2 flex flex-col gap-2 px-1">
      {files.length > 0 && (
        <ul aria-label="Files to send" className="flex flex-wrap gap-2">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex max-w-[260px] items-center gap-2 rounded-xl border border-forge-700 bg-forge-900 py-1 pr-1 pl-1.5"
            >
              <Thumb where={{ draft: f.draft }} a={f} />
              <span className="min-w-0 text-xs">
                <span className="block truncate text-ash-200" title={f.name}>
                  {f.name}
                </span>
                <span className="block truncate text-[10px] text-ash-500">
                  {detail(f)} · not sent yet
                </span>
              </span>
              <button
                onClick={() => onRemove(f.id)}
                disabled={disabled}
                aria-label={`Remove ${f.name}`}
                title="Remove"
                className="ml-auto rounded-full px-1.5 text-ash-500 hover:text-ember-600 disabled:opacity-40"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <div role="alert" className="flex items-start gap-2 text-xs text-ember-600">
          <ul className="flex-1">
            {errors.map((e, i) => (
              <li key={i} className="[overflow-wrap:anywhere]">
                <span className="text-ash-300">{e.name}</span>: {e.error}
              </li>
            ))}
          </ul>
          <button onClick={onDismiss} className="text-ash-500 hover:text-ash-300" title="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  )
}

// Under a sent message: its files, and whether the provider received them.
export function SentFiles({
  chat,
  files
}: {
  chat: string
  files: Attachment[]
}): React.JSX.Element | null {
  if (!files.length) return null
  const to = [...new Set(files.flatMap((f) => f.sentTo ?? []))] as Provider[]
  return (
    <div aria-label="Attached files" className="mt-1.5 flex flex-col items-end gap-1">
      <ul className="flex flex-wrap justify-end gap-1.5">
        {files.map((f) => (
          <li
            key={f.id}
            className="flex max-w-[240px] items-center gap-2 rounded-xl border border-forge-700 bg-forge-900/60 py-1 pr-2 pl-1.5"
          >
            <Thumb where={{ chat }} a={f} />
            <span className="min-w-0 text-xs">
              <span className="block truncate text-ash-200" title={f.name}>
                {f.name}
              </span>
              <span className="block truncate text-[10px] text-ash-500">
                {f.missing ? "Custard's copy is missing; no longer sent" : detail(f)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <span className="text-[10px] text-ash-500">
        {to.length
          ? `Sent to ${to.map((p) => providerNames[p]).join(' and ')}`
          : 'Not received by a provider: the request did not go through'}
      </span>
    </div>
  )
}
