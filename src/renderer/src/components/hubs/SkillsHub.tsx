import { useEffect, useMemo, useState } from 'react'
import { modes } from '../../../../shared/chat'
import type { AutomationView } from '../../../../shared/automations'
import { pluginIdFrom } from '../../../../shared/plugins'
import type { SkillEntry } from '../../../../shared/vault'
import { PlusIcon } from '../icons'
import { cleanError } from '../settings/ui'
import SkillPanel from './SkillPanel'

// Skills mode's start page: every skill in Custard/Skills, what each does and
// where it is used. Pressing a card enters that skill's workspace (its chats,
// and new chats that can write only that skill). Add asks for a name, makes
// the skill's folder with a draft and enters it.

type Props = {
  onEnter: (folder: string) => void
  onOpenSettings: () => void
}

const chip = 'rounded-full border border-forge-700 px-2.5 py-0.5 text-[11px] text-ash-400'
const pill =
  'rounded-full border border-forge-700 bg-forge-850/80 px-3 py-1 text-xs text-ash-300 transition-colors hover:border-molten-500/50 hover:text-molten-200'
const field =
  'w-48 rounded-full border border-forge-700 bg-forge-900 px-3 py-1 text-xs outline-none focus:border-molten-500/60'

const modeLabel = (id: string): string => modes.find((m) => m.id === id)?.label ?? id

function SkillsHub({ onEnter, onOpenSettings }: Props): React.JSX.Element {
  const [skills, setSkills] = useState<SkillEntry[] | null | undefined>(undefined)
  const [automations, setAutomations] = useState<AutomationView[]>([])
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<SkillEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

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

  // The folder Custard will make (numbered by the main process if taken).
  const newFolder = pluginIdFrom(
    newName,
    new Set((skills ?? []).map((x) => x.folder.toLowerCase()))
  )
  const create = async (): Promise<void> => {
    try {
      setError(null)
      const folder = await window.custard.skills.create(newName.trim())
      setAdding(false)
      setNewName('')
      onEnter(folder)
    } catch (e) {
      setError(cleanError(e))
    }
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
            onClick={() => setAdding(!adding)}
            className="molten-fill flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium text-forge-950"
          >
            <PlusIcon className="h-3.5 w-3.5" /> Add a skill
          </button>
        </div>
      </div>
      {adding && (
        <form
          className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-forge-700 bg-forge-850/60 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (newFolder) void create()
          }}
        >
          <input
            aria-label="New skill name"
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name, e.g. Meeting notes"
            className={field}
          />
          <button type="submit" className={pill} disabled={!newFolder}>
            Create and open
          </button>
          <span className="text-xs text-ash-500" data-new-skill-folder>
            {newFolder
              ? `Custard makes Custard/Skills/${newFolder} with a draft SKILL.md, used only in Skills mode until you finish it.`
              : newName.trim()
                ? 'Use at least one letter from a to z: Custard makes the folder name from it.'
                : 'Custard makes a folder for it from the name, with a draft SKILL.md.'}
          </span>
        </form>
      )}
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
                className="group relative flex flex-col rounded-2xl border border-forge-700 bg-forge-850/60 p-4 transition-colors hover:border-molten-500/40"
              >
                {/* The whole card enters the workspace; Inspect sits above it. */}
                <button
                  onClick={() => onEnter(s.folder)}
                  aria-label={`Open ${s.name}`}
                  className="absolute inset-0 rounded-2xl focus:outline-none focus-visible:ring-1 focus-visible:ring-molten-500/60"
                />
                <div className="pointer-events-none flex items-start gap-2">
                  <h2 className="font-medium text-ash-100 group-hover:text-molten-200">{s.name}</h2>
                  {s.starter && <span className={`${chip} ml-auto shrink-0`}>Starter</span>}
                </div>
                {s.problem ? (
                  <p className="pointer-events-none mt-1 text-xs text-ember-600">{s.problem}</p>
                ) : (
                  <p className="pointer-events-none mt-1 line-clamp-3 text-sm text-ash-400">
                    {s.description}
                  </p>
                )}
                <div className="pointer-events-none mt-3 flex flex-wrap gap-1.5">
                  <span className={chip}>
                    {s.modes.length ? s.modes.map(modeLabel).join(', ') : 'All modes'}
                  </span>
                  {runs.length > 0 && (
                    <span className={chip}>
                      {runs.length === 1 ? '1 automation' : `${runs.length} automations`}
                    </span>
                  )}
                </div>
                <div className="pointer-events-none mt-auto flex items-center gap-2 pt-4">
                  <button
                    className={`${pill} pointer-events-auto relative`}
                    onClick={() => setOpen(s)}
                  >
                    Inspect
                  </button>
                  <span className="ml-auto text-xs text-ash-500 group-hover:text-molten-300">
                    Open workspace ›
                  </span>
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
          onEnter={() => {
            setOpen(null)
            onEnter(open.folder)
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

export default SkillsHub
