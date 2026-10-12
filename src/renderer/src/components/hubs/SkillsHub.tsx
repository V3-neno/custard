import { useEffect, useMemo, useState } from 'react'
import { modes } from '../../../../shared/chat'
import type { AutomationView } from '../../../../shared/automations'
import type { SkillEntry, SkillText } from '../../../../shared/vault'
import Markdown from '../Markdown'
import { CloseIcon, PlusIcon } from '../icons'
import { cleanError } from '../settings/ui'

// Skills mode's start page: every skill in Custard/Skills, what each does and
// where it is used. Adding or improving one starts a Skills chat with the
// request filled in; the chat writes the skill and asks first, as before.

type Props = {
  // Puts a request in the message box (not sent).
  onStart: (text: string) => void
  onOpenSettings: () => void
}

const chip = 'rounded-full border border-forge-700 px-2.5 py-0.5 text-[11px] text-ash-400'
const pill =
  'rounded-full border border-forge-700 bg-forge-850/80 px-3 py-1 text-xs text-ash-300 transition-colors hover:border-molten-500/50 hover:text-molten-200'

const modeLabel = (id: string): string => modes.find((m) => m.id === id)?.label ?? id

function when(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

// The body without its frontmatter, which the panel shows as fields.
const body = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')

function SkillsHub({ onStart, onOpenSettings }: Props): React.JSX.Element {
  const [skills, setSkills] = useState<SkillEntry[] | null | undefined>(undefined)
  const [automations, setAutomations] = useState<AutomationView[]>([])
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<SkillEntry | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.custard.skills
      .list()
      .then(setSkills)
      .catch((e) => setError(cleanError(e)))
    window.custard.automations
      .list()
      .then(setAutomations)
      .catch(() => {})
  }, [])

  const usedBy = (folder: string): AutomationView[] =>
    automations.filter((a) => a.automation.skill === folder)

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!skills || !q) return skills ?? []
    return skills.filter((s) =>
      [s.name, s.folder, s.description].some((x) => x.toLowerCase().includes(q))
    )
  }, [skills, filter])

  const improve = (s: SkillEntry): void => {
    setOpen(null)
    onStart(`Improve the "${s.name}" skill (${s.path}). `)
  }

  if (skills === null)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-semibold text-molten-200">Your skills live in your vault</h1>
        <p className="text-sm text-ash-400">
          Connect your Obsidian vault to see, add and improve skills.
        </p>
        <button onClick={onOpenSettings} className={pill}>
          Open Settings
        </button>
      </div>
    )

  return (
    <div className="mx-auto w-full max-w-4xl px-6 pt-8 pb-6">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">Skills</div>
          <h1 className="text-2xl font-semibold tracking-tight text-molten-200">
            What Custard knows how to do
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            aria-label="Find a skill"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a skill…"
            className="w-44 rounded-full border border-forge-700 bg-forge-900 px-3 py-1 text-xs outline-none focus:border-molten-500/60"
          />
          <button
            onClick={() => onStart('Help me make a new skill: ')}
            className="molten-fill flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium text-forge-950"
          >
            <PlusIcon className="h-3.5 w-3.5" /> Add a skill
          </button>
        </div>
      </div>
      {error && <p className="mb-3 text-xs text-ember-600">{error}</p>}
      {skills === undefined ? null : skills.length === 0 ? (
        <p className="py-10 text-center text-sm text-ash-500">
          No skills yet. Add one, or add the starter skills in Settings.
        </p>
      ) : shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-ash-500">No skill matches that.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((s) => {
            const runs = usedBy(s.folder)
            return (
              <article
                key={s.folder}
                aria-label={`Skill ${s.name}`}
                className="flex flex-col rounded-2xl border border-forge-700 bg-forge-850/60 p-4 transition-colors hover:border-molten-500/40"
              >
                <div className="flex items-start gap-2">
                  <h2 className="font-medium text-ash-100">{s.name}</h2>
                  {s.starter && <span className={`${chip} ml-auto shrink-0`}>Starter</span>}
                </div>
                {s.problem ? (
                  <p className="mt-1 text-xs text-ember-600">{s.problem}</p>
                ) : (
                  <p className="mt-1 line-clamp-3 text-sm text-ash-400">{s.description}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className={chip}>
                    {s.modes.length ? s.modes.map(modeLabel).join(', ') : 'All modes'}
                  </span>
                  {runs.length > 0 && (
                    <span className={chip}>
                      {runs.length === 1 ? '1 automation' : `${runs.length} automations`}
                    </span>
                  )}
                </div>
                <div className="mt-auto flex gap-2 pt-4">
                  <button className={pill} onClick={() => setOpen(s)}>
                    Inspect
                  </button>
                  <button className={pill} onClick={() => improve(s)}>
                    Improve
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
      {open && (
        <SkillPanel
          skill={open}
          automations={usedBy(open.folder)}
          onImprove={() => improve(open)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

function SkillPanel(props: {
  skill: SkillEntry
  automations: AutomationView[]
  onImprove: () => void
  onClose: () => void
}): React.JSX.Element {
  const { skill, automations, onImprove, onClose } = props
  const [text, setText] = useState<SkillText | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (skill.problem?.includes('no SKILL.md')) return
    window.custard.skills
      .read(skill.folder)
      .then(setText)
      .catch((e) => setError(cleanError(e)))
  }, [skill])

  return (
    <div className="fixed inset-0 z-20 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <aside
        role="dialog"
        aria-label={`About ${skill.name}`}
        className="relative flex h-full w-full max-w-xl flex-col border-l border-forge-700 bg-forge-900/95 backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-6 pt-5 pb-3">
          <div className="min-w-0">
            <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">Skill</div>
            <div className="truncate text-lg font-semibold text-molten-200">{skill.name}</div>
            <div className="truncate text-xs text-ash-500">{skill.path}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-full p-2 text-ash-400 hover:bg-forge-800 hover:text-molten-300"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="forge-line mx-6 mb-3" />
        <div className="flex-1 overflow-y-auto px-6 pb-6 text-sm">
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-ash-500">What it does</dt>
            <dd className={skill.problem ? 'text-ember-600' : 'text-ash-300'}>
              {skill.problem ?? skill.description}
            </dd>
            <dt className="text-ash-500">Used in</dt>
            <dd className="text-ash-300">
              {skill.modes.length ? skill.modes.map(modeLabel).join(', ') : 'Every mode'}
            </dd>
            <dt className="text-ash-500">Automations</dt>
            <dd className="text-ash-300">
              {automations.length
                ? automations
                    .map((a) => `${a.automation.name}${a.automation.enabled ? '' : ' (off)'}`)
                    .join(', ')
                : 'None'}
            </dd>
            {skill.updatedAt && (
              <>
                <dt className="text-ash-500">Changed</dt>
                <dd className="text-ash-300">{when(skill.updatedAt)}</dd>
              </>
            )}
            {skill.files.length > 0 && (
              <>
                <dt className="text-ash-500">Other files</dt>
                <dd className="text-ash-300">
                  {skill.files.map((f) => f.split('/').slice(3).join('/')).join(', ')}
                  {skill.moreFiles > 0 ? `, and ${skill.moreFiles} more` : ''}
                </dd>
              </>
            )}
          </dl>
          <div className="forge-line my-4" />
          {error && <p className="text-xs text-ember-600">{error}</p>}
          {text && (
            <>
              <Markdown text={body(text.text)} />
              {text.truncated && (
                <p className="mt-3 text-xs text-ash-500">
                  Only the start is shown here; the note is longer. Open it in Obsidian to read the
                  rest.
                </p>
              )}
            </>
          )}
        </div>
        <div className="flex gap-2 border-t border-forge-700 px-6 py-3">
          <button
            onClick={onImprove}
            className="molten-fill rounded-full px-4 py-1.5 text-xs font-medium text-forge-950"
          >
            Improve this skill
          </button>
        </div>
      </aside>
    </div>
  )
}

export default SkillsHub
