import type { WorkspaceProposal } from '../../../../shared/chat'
import { pluginIdFrom } from '../../../../shared/plugins'

// A hub chat's offer to enter a plugin's or skill's workspace, or to create
// one and enter it. Only Yes here does it; then a new chat starts in the
// workspace with the request in its message box, not sent.

type Props = {
  p: WorkspaceProposal
  names: Record<string, string>
  busy: boolean
  error?: string
  onAnswer: (yes: boolean) => void
}

function ProposalCard({ p, names, busy, error, onAnswer }: Props): React.JSX.Element {
  const isSkill = p.target === 'skill'
  const id = isSkill ? p.skill : p.pluginId
  const name = p.kind === 'open' ? (names[id ?? ''] ?? id) : p.name
  // Where it lives; a new one's folder comes from its name.
  const path = `${isSkill ? 'Custard/Skills' : 'plugin'}/${id ?? pluginIdFrom(p.name ?? '')}`
  const one = isSkill ? 'skill' : 'plugin'
  const question =
    p.kind === 'open'
      ? isSkill
        ? `Open the ${name} skill workspace?`
        : `Open the ${name} workspace?`
      : `Create a new ${one} called ${name}?`
  return (
    <div
      role="group"
      aria-label={question}
      data-proposal={p.status}
      className="rounded-2xl border border-molten-500/30 bg-forge-850/70 px-4 py-3"
    >
      <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">
        {p.kind === 'open' ? 'Enter workspace' : `New ${one}`}
      </div>
      <div className="mt-1 font-medium text-ash-100">{question}</div>
      <div className="mt-1 text-xs text-ash-400">
        {p.kind === 'open'
          ? isSkill
            ? `A new chat starts in ${path}, where it can change only that skill's files.`
            : `A new chat starts in ${path}, where changes to its files are possible (each one asks first).`
          : isSkill
            ? `Custard makes ${path} with a draft SKILL.md, then starts a new chat in it.`
            : `Custard makes ${path} with a working sample, then starts a new chat in it.`}{' '}
        This message goes in its box for you to check and send:
      </div>
      <blockquote className="mt-2 border-l-2 border-forge-700 pl-3 text-sm whitespace-pre-wrap text-ash-300">
        {p.request}
      </blockquote>
      {error && <p className="mt-2 text-xs text-ember-600">{error}</p>}
      {p.status === 'pending' ? (
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            onClick={() => onAnswer(true)}
            className="molten-fill rounded-full px-4 py-1.5 text-xs font-medium text-forge-950 disabled:opacity-40"
          >
            {p.kind === 'open' ? 'Yes, open it' : 'Yes, create it'}
          </button>
          <button
            disabled={busy}
            onClick={() => onAnswer(false)}
            className="rounded-full border border-forge-700 px-4 py-1.5 text-xs text-ash-300 transition-colors hover:text-molten-200 disabled:opacity-40"
          >
            Not now
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-ash-500">
          {p.status === 'accepted'
            ? p.kind === 'open'
              ? 'You opened it.'
              : `You created it (${path}).`
            : 'You said not now.'}
        </p>
      )}
    </div>
  )
}

export default ProposalCard
