import type { Conversation } from './chat'

// Text in a chat that doesn't come from the user or from Custard: web search
// results and pages, and what plugin tools return. Anything in it can be
// written to look like an instruction, so once it is in a chat, changes to
// notes ask first (see main/chat.ts), and the chat says so.
const WEB_TOOLS = new Set(['web_search', 'web_read'])
const PLUGIN_TOOL = /^[a-z][a-z0-9-]{1,30}__[a-z][a-z0-9_]{0,40}$/

export const isOutsideTool = (name: string): boolean =>
  WEB_TOOLS.has(name) || PLUGIN_TOOL.test(name)

// True when a web or plugin tool has run in this chat (or is running, or its
// outcome is unknown: a result may have come back), or the chat continues one
// whose summary may carry such text. Once true it stays true: the results are
// part of the chat from then on.
export function chatHasOutsideText(
  c: Pick<Conversation, 'actions' | 'continuedFrom'> | null | undefined
): boolean {
  if (!c) return false
  if (c.continuedFrom) return true
  return Object.values(c.actions ?? {}).some(
    (a) => isOutsideTool(a.name) && a.status !== 'not-run' && a.status !== 'pending'
  )
}
