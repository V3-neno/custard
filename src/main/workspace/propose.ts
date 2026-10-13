import { randomUUID } from 'crypto'
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Conversation, WorkspaceProposal } from '../../shared/chat'
import { pluginIdFrom } from '../../shared/plugins'

// The Plugins hub chat brainstorms and navigates; it can't touch files,
// plugins or notes (see modes/policy). When the user wants to work on a
// plugin, or to make a new one, it offers to with this tool. The offer is a
// card in the chat; only the user's Yes on it enters the workspace or makes
// the plugin (acceptProposal, called from the card, never by the model).

export const PROPOSE_TOOL = 'workspace_propose'
const MAX_REQUEST = 2000

export const proposeTool: BetaTool = {
  name: PROPOSE_TOOL,
  description:
    "Offer to take the user into a plugin's workspace, or to create a new plugin and take them into its workspace. Shows the user a card with Yes and Not now; nothing happens unless they press Yes, and then a new chat starts in that workspace with `request` in its message box for them to send. Use it when the user wants to change, build, fix or test a plugin. At most one offer per answer; then stop and let the user decide.",
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'create'],
        description: 'open: an existing plugin. create: a new plugin.'
      },
      plugin: { type: 'string', description: "open: the plugin's id, e.g. spotify." },
      name: {
        type: 'string',
        description: 'create: a short name for the new plugin, e.g. "SEO Check".'
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

export const PROPOSE_PROMPT = [
  'The user is on the Plugins hub, not in a plugin workspace. Here you brainstorm and help them find their way: answer questions about plugins and ideas, read their notes, earlier chats and the web when it helps, and sketch plans.',
  "You can't change anything here: no plugin files, no plugins, no notes. Don't offer to and don't say you did.",
  'When the user wants to change, build, fix or test a plugin, call workspace_propose: action "open" with the plugin id for an existing plugin, or action "create" with a name for a new one. The user then decides on a card. If they only want to brainstorm, just talk.'
].join('\n')

type Result = { content: string; isError: boolean; outcome: 'completed' | 'not-run' }

// Records the offer on the chat; the card shows it. Changes nothing else.
export function runProposeTool(
  conversation: Conversation,
  input: unknown,
  turn: number,
  plugins: { id: string; name: string }[]
): Result {
  const refuse = (content: string): Result => ({ content, isError: true, outcome: 'not-run' })
  const i = (input ?? {}) as Record<string, unknown>
  const request = typeof i.request === 'string' ? i.request.trim().slice(0, MAX_REQUEST) : ''
  if (!request) return refuse('Say what the user wants done in the workspace (request).')
  if ((conversation.proposals ?? []).some((p) => p.turn === turn))
    return refuse('Only one offer per answer, and this answer already has one.')
  let p: WorkspaceProposal
  if (i.action === 'open') {
    const plugin = plugins.find((x) => x.id === i.plugin)
    if (!plugin)
      return refuse(
        `There is no plugin with that id. The plugins are: ${plugins.map((x) => `${x.id} (${x.name})`).join(', ') || 'none yet'}.`
      )
    p = { id: randomUUID(), turn, kind: 'open', pluginId: plugin.id, request, status: 'pending' }
  } else if (i.action === 'create') {
    const name = typeof i.name === 'string' ? i.name.trim().slice(0, 60) : ''
    if (!name || !pluginIdFrom(name))
      return refuse('Give the new plugin a short name with at least one letter from a to z.')
    p = { id: randomUUID(), turn, kind: 'create', name, request, status: 'pending' }
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
}

// The user's answer on the card. Yes on "open" checks the plugin is still
// there; Yes on "create" makes the plugin. Returns the plugin to enter and
// the request for the new chat's message box.
export function answerProposal(
  c: Conversation,
  id: string,
  yes: boolean,
  deps: AcceptDeps
): { pluginId: string; request: string } | null {
  const p = c.proposals?.find((x) => x.id === id)
  if (!p) throw new Error('That offer is no longer in this chat.')
  if (p.status !== 'pending') throw new Error('That offer was already answered.')
  if (!yes) {
    p.status = 'declined'
    return null
  }
  if (p.kind === 'open') {
    if (!p.pluginId || !deps.pluginExists(p.pluginId))
      throw new Error(`plugin/${p.pluginId} isn't there any more.`)
  } else p.pluginId = deps.create(p.name ?? '')
  p.status = 'accepted'
  return { pluginId: p.pluginId, request: p.request }
}
