import { useCallback, useEffect, useState } from 'react'
import { modes, type ConversationSummary } from '../../../../shared/chat'
import type { AutomationView } from '../../../../shared/automations'
import type { SkillEntry } from '../../../../shared/vault'
import { cleanError } from '../settings/ui'
import ChatCards from './ChatCards'
import SkillPanel from './SkillPanel'

// One skill's workspace: its chats as cards, newest first, and the message
// box below to start a new one. Chats started here can write only inside
// this skill's folder (see main/modes/policy).

type Props = {
  folder: string
  onOpen: (chatId: string) => void
  onBack: () => void
}

const pill =
  'rounded-full border border-forge-700 bg-forge-850/80 px-3 py-1 text-xs text-ash-300 transition-colors hover:border-molten-500/50 hover:text-molten-200'

const modeLabel = (id: string): string => modes.find((m) => m.id === id)?.label ?? id

function SkillWorkspace({ folder, onOpen, onBack }: Props): React.JSX.Element {
  const [skill, setSkill] = useState<SkillEntry | null | undefined>(undefined)
  const [automations, setAutomations] = useState<AutomationView[]>([])
  const [chats, setChats] = useState<ConversationSummary[] | null>(null)
  const [inspect, setInspect] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    window.custard.skills
      .list()
      .then((list) => setSkill(list?.find((s) => s.folder === folder) ?? null))
      .catch((e) => setError(cleanError(e)))
    window.custard.automations
      .list()
      .then((a) => setAutomations(a.filter((x) => x.automation.skill === folder)))
      .catch(() => {})
    // Already newest first.
    window.custard.conversations
      .list('skills')
      .then((list) => setChats(list.filter((c) => c.skill === folder)))
      .catch((e) => setError(cleanError(e)))
  }, [folder])
  useEffect(() => load(), [load])

  if (skill === null)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-semibold text-molten-200">Custard/Skills/{folder} is gone</h1>
        <p className="text-sm text-ash-400">
          It was moved or deleted in the vault, or the vault isn&apos;t connected. Its chats are
          still in History.
        </p>
        <button onClick={onBack} className={pill}>
          Back to Skills
        </button>
      </div>
    )

  return (
    <div className="mx-auto w-full max-w-4xl px-6 pt-6 pb-6">
      <div className="mb-5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">
            Workspace · Custard/Skills/{folder}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-molten-200">
            {skill?.name ?? folder}
          </h1>
          {skill &&
            (skill.problem ? (
              <p className="mt-1 text-sm text-ember-600">{skill.problem}</p>
            ) : (
              <p className="mt-1 line-clamp-2 text-sm text-ash-400">{skill.description}</p>
            ))}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-5">
          {skill && (
            <span className="text-xs text-ash-500">
              {skill.modes.length ? skill.modes.map(modeLabel).join(', ') : 'All modes'}
            </span>
          )}
          {skill && (
            <button className={pill} onClick={() => setInspect(true)}>
              Inspect
            </button>
          )}
        </div>
      </div>
      {error && <p className="mb-3 text-xs text-ember-600">{error}</p>}
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-xs tracking-[0.2em] text-ash-500 uppercase">Chats</h2>
        <span className="text-xs text-ash-500">
          Newest first. Describe a change below to start a new one; it can write only this
          skill&apos;s folder.
        </span>
      </div>
      <ChatCards
        chats={chats}
        empty={`No chats in this workspace yet. What should ${skill?.name ?? folder} do?`}
        onOpen={onOpen}
      />
      {inspect && skill && (
        <SkillPanel
          skill={skill}
          automations={automations}
          onClose={() => {
            setInspect(false)
            load()
          }}
        />
      )}
    </div>
  )
}

export default SkillWorkspace
