import { randomUUID } from 'crypto'
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Conversation, WorkspaceProposal } from '../../shared/chat'
import { pluginIdFrom } from '../../shared/plugins'

// The hub chats (Plugins and Skills) brainstorm and navigate; they can't
// touch files, plugins, skills or notes (see modes/policy). When the user
// wants to work on a plugin or skill, or to make a new one, they offer to
// with this tool. The offer is a
// card in the chat; only the user's Yes on it enters the workspace or makes
// the plugin (acceptProposal, called from the card, never by the model).

export const PROPOSE_TOOL = 'workspace_propose'
const MAX_REQUEST = 2000

export type ProposeTarget = 'plugin' | 'skill'

const WHAT: Record<ProposeTarget, { one: string; id: string; example: string; name: string }> = {
  plugin: { one: 'plugin', id: 'plugin', example: 'spotify', name: 'SEO Check' },
  skill: { one: 'skill', id: 'skill', example: 'weekly-review', name: 'Meeting notes' }
}

// The tool as the Plugins hub (plugins) or the Skills hub (skills) offers it.
export function proposeTool(target: ProposeTarget): BetaTool {
  const w = WHAT[target]
  return {
    name: PROPOSE_TOOL,
    description: `Offer to take the user into a ${w.one}'s workspace, or to create a new ${w.one} and take them into its workspace. Shows the user a card with Yes and Not now; nothing happens unless they press Yes, and then a new chat starts in that workspace with \`request\` in its message box for them to send. Use it when the user wants to change, build, fix or test a ${w.one}. At most one offer per answer; then stop and let the user decide.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'create'],
          description: `open: an existing ${w.one}. create: a new ${w.one}.`
        },
        [w.id]: {
          type: 'string',
          description: `open: the ${w.one}'s ${target === 'plugin' ? 'id' : 'folder'}, e.g. ${w.example}.`
        },
        name: {
          type: 'string',
          description: `create: a short name for the new ${w.one}, e.g. "${w.name}".`
        },
        request: {
          type: 'string',
          description:
            "What the user wants done in the workspace, in the user's own words and language, as the first message of the new chat."
        }
      },
      required: ['action', 'request']
    }
  }
}

export function proposePrompt(target: ProposeTarget): string {
  const w = WHAT[target]
  const hub = target === 'plugin' ? 'Plugins' : 'Skills'
  return [
    `The user is on the ${hub} hub, not in a ${w.one}'s workspace. Here you brainstorm and help them find their way: answer questions about ${w.one}s and ideas, read their notes, earlier chats and the web when it helps, and sketch plans.`,
    `You can't change anything here: no ${target === 'plugin' ? 'plugin files, no plugins' : 'skills'}, no notes. Don't offer to and don't say you did.`,
    `When the user wants to change, build, fix or test a ${w.one}, call workspace_propose: action "open" with the ${w.one}'s ${target === 'plugin' ? 'id' : 'folder'} for an existing one, or action "create" with a name for a new one. The user then decides on a card. If they only want to brainstorm, just talk.`
  ].join('\n')
}

type Result = { content: string; isError: boolean; outcome: 'completed' | 'not-run' }

// Records the offer on the chat; the card shows it. Changes nothing else.
export function runProposeTool(
  conversation: Conversation,
  input: unknown,
  turn: number,
  // What can be opened: plugins by id, or skills by folder.
  target: ProposeTarget,
  plugins: { id: string; name: string }[]
): Result {
  const w = WHAT[target]
  const refuse = (content: string): Result => ({ content, isError: true, outcome: 'not-run' })
  const i = (input ?? {}) as Record<string, unknown>
  const request = typeof i.request === 'string' ? i.request.trim().slice(0, MAX_REQUEST) : ''
  if (!request) return refuse('Say what the user wants done in the workspace (request).')
  if ((conversation.proposals ?? []).some((p) => p.turn === turn))
    return refuse('Only one offer per answer, and this answer already has one.')
  let p: WorkspaceProposal
  const skill = target === 'skill' ? { target: 'skill' as const } : {}
  if (i.action === 'open') {
    const found = plugins.find((x) => x.id === i[w.id])
    if (!found)
      return refuse(
        `There is no ${w.one} with that ${target === 'plugin' ? 'id' : 'folder'}. The ${w.one}s are: ${plugins.map((x) => `${x.id} (${x.name})`).join(', ') || 'none yet'}.`
      )
    p = {
      id: randomUUID(),
      turn,
      kind: 'open',
      ...skill,
      ...(target === 'plugin' ? { pluginId: found.id } : { skill: found.id }),
      request,
      status: 'pending'
    }
  } else if (i.action === 'create') {
    const name = typeof i.name === 'string' ? i.name.trim().slice(0, 60) : ''
    if (!name || !pluginIdFrom(name))
      return refuse(`Give the new ${w.one} a short name with at least one letter from a to z.`)
    p = { id: randomUUID(), turn, kind: 'create', ...skill, name, request, status: 'pending' }
  } else return refuse('action must be "open" or "create".')
  ;(conversation.proposals ??= []).push(p)
  return {
    content:
      'The offer is shown to the user as a card. Nothing has changed: they decide with Yes or Not now. Stop here and let them choose.',
    isError: false,
    outcome: 'completed'
  }
}

export type AcceptDeps = {
  pluginExists: (id: string) => boolean
  create: (name: string) => string
  skillExists: (folder: string) => boolean
  createSkill: (name: string) => string
}

// The user's answer on the card. Yes on "open" checks the plugin or skill
// is still there; Yes on "create" makes it. Returns the workspace to enter
// and the request for the new chat's message box.
export function answerProposal(
  c: Conversation,
  id: string,
  yes: boolean,
  deps: AcceptDeps
): { pluginId?: string; skill?: string; request: string } | null {
  const p = c.proposals?.find((x) => x.id === id)
  if (!p) throw new Error('That offer is no longer in this chat.')
  if (p.status !== 'pending') throw new Error('That offer was already answered.')
  if (!yes) {
    p.status = 'declined'
    return null
  }
  if (p.target === 'skill') {
    if (p.kind === 'open') {
      if (!p.skill || !deps.skillExists(p.skill))
        throw new Error(`The ${p.skill} skill isn't there any more.`)
    } else p.skill = deps.createSkill(p.name ?? '')
    p.status = 'accepted'
    return { skill: p.skill, request: p.request }
  }
  if (p.kind === 'open') {
    if (!p.pluginId || !deps.pluginExists(p.pluginId))
      throw new Error(`plugin/${p.pluginId} isn't there any more.`)
  } else p.pluginId = deps.create(p.name ?? '')
  p.status = 'accepted'
  return { pluginId: p.pluginId, request: p.request }
}
