import { useEffect, useState } from 'react'
import type { SkillChange } from '../../../../shared/design'
import type { ViewerProps } from './viewers/types'

// Which skills shaped a version, compactly, with the details a click away:
// how each was chosen, the guidance relied on (kept with the version), and
// whether the skill has changed or gone since. A change is only offered:
// the buttons put a request in the message box for the user to send or not.
// Nothing is restyled on its own.

const HOW = { explicit: 'you named it', matched: 'it matched the request' }

export default function SkillsUsed({
  chat,
  artifact,
  version,
  onDraft
}: ViewerProps & { onDraft: (text: string) => void }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [changes, setChanges] = useState<{ key: string; list: SkillChange[] } | null>(null)
  const key = `${artifact.id}/${version.id}`
  const count = version.skills.length

  useEffect(() => {
    if (!count) return
    let gone = false
    const load = (): void =>
      void window.custard.design
        .skillChanges(chat, artifact.id, version.id)
        .then((list) => !gone && setChanges({ key, list }))
    load()
    // Skills are edited in Obsidian or Skills mode; look again on return.
    window.addEventListener('focus', load)
    return () => {
      gone = true
      window.removeEventListener('focus', load)
    }
  }, [chat, artifact.id, version.id, key, count])

  if (!count) return null
  const state = (path: string): SkillChange['state'] | null =>
    (changes?.key === key ? changes.list : []).find((c) => c.path === path)?.state ?? null
  const changed = version.skills.filter((s) => state(s.path) && state(s.path) !== 'same')

  return (
    <section
      className="mt-2 rounded-xl border border-forge-700 bg-forge-850/60 text-xs"
      aria-label="Skills used"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ash-400 hover:text-ash-100"
      >
        <span className="text-ash-500">Skills used</span>
        <span className="min-w-0 flex-1 truncate text-molten-200">
          {version.skills.map((s) => s.name).join(', ')}
        </span>
        {changed.length > 0 && (
          <span className="rounded-full border border-molten-500/40 px-2 py-0.5 text-[10px] text-molten-300">
            {changed.length === 1 ? '1 changed since' : `${changed.length} changed since`}
          </span>
        )}
        <span aria-hidden className="text-ash-500">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <ul className="flex flex-col gap-2 px-3 pb-3">
          {version.skills.map((s) => {
            const st = state(s.path)
            return (
              <li key={s.path} className="rounded-lg bg-forge-900 p-2" data-skill={s.name}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-ash-100">{s.name}</span>
                  <span className="text-ash-500">used because {HOW[s.how]}</span>
                  <span
                    className="text-ash-500"
                    title={`SHA-256 of the SKILL.md as read: ${s.fingerprint}`}
                  >
                    · {s.fingerprint.slice(0, 8)}
                  </span>
                  {st === 'changed' && (
                    <span className="text-molten-300">· changed since this version</span>
                  )}
                  {st === 'missing' && (
                    <span className="text-ember-600">· no longer in your vault</span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-ash-500">{s.path}</p>
                {s.guidance && (
                  <p className="mt-1 max-h-24 overflow-auto text-[11px] whitespace-pre-wrap text-ash-400">
                    {s.guidance}
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {st === 'changed' && (
                    <button
                      className="rounded-full border border-forge-700 px-2.5 py-0.5 text-[11px] text-ash-300 hover:border-molten-500/50 hover:text-molten-200"
                      onClick={() =>
                        onDraft(
                          `Make a new version of "${artifact.name}" (v${version.n}) following the updated "${s.name}" skill.`
                        )
                      }
                    >
                      Use the updated skill
                    </button>
                  )}
                  <button
                    className="rounded-full border border-forge-700 px-2.5 py-0.5 text-[11px] text-ash-300 hover:border-molten-500/50 hover:text-molten-200"
                    onClick={() =>
                      onDraft(
                        `Make a new version of "${artifact.name}" (v${version.n}) without the "${s.name}" skill.`
                      )
                    }
                  >
                    Without this skill
                  </button>
                </div>
              </li>
            )
          })}
          <li className="text-[11px] text-ash-500">
            Skills shape the result; they don&apos;t mean their checks ran. Buttons only fill in the
            message box.
          </li>
        </ul>
      )}
    </section>
  )
}
