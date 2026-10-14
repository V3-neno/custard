import { useEffect, useState } from 'react'
import { modes } from '../../../../shared/chat'
import type { AutomationView } from '../../../../shared/automations'
import type { SkillEntry, SkillText } from '../../../../shared/vault'
import Markdown from '../Markdown'
import { CloseIcon } from '../icons'
import { cleanError } from '../settings/ui'

// One skill's details and its SKILL.md, in a panel that floats in from the
// right (from the Skills hub and from the skill's workspace).

const modeLabel = (id: string): string => modes.find((m) => m.id === id)?.label ?? id

function when(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

// The body without its frontmatter, which the panel shows as fields.
const body = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')

function SkillPanel(props: {
  skill: SkillEntry
  automations: AutomationView[]
  // From the hub: enter the skill's workspace. Left out inside it.
  onEnter?: () => void
  onClose: () => void
}): React.JSX.Element {
  const { skill, automations, onEnter, onClose } = props
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
    <div className="fixed inset-0 z-20 flex items-center justify-end p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <aside
        role="dialog"
        aria-label={`About ${skill.name}`}
        className="panel-in relative flex max-h-[min(100%,80vh)] w-full max-w-xl flex-col rounded-2xl border border-forge-700 bg-forge-900/95 shadow-2xl shadow-black/60 backdrop-blur"
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
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 text-sm">
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
        {onEnter && (
          <div className="flex gap-2 border-t border-forge-700 px-6 py-3">
            <button
              onClick={onEnter}
              className="molten-fill rounded-full px-4 py-1.5 text-xs font-medium text-forge-950"
            >
              Open its workspace
            </button>
          </div>
        )}
      </aside>
    </div>
  )
}

export default SkillPanel
