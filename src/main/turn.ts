import type {
  BetaContentBlockParam,
  BetaToolResultBlockParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ActionRecord, ActionStatus, Conversation, NoticeKind } from '../shared/chat'

// Keeps a turn's history honest when it doesn't finish normally. Every tool
// call is recorded as it happens and saved at each change, so a stop, an
// error or a crash never loses what already ran, and nothing is run again
// without the user knowing.

export type Outcome = 'completed' | 'failed' | 'not-run' | 'unknown'
export type ToolRun = { content: string; isError: boolean; outcome?: Outcome }
export type Call = { id: string; name: string; input: unknown; label: string; write: boolean }

// Same name and same input, whatever the key order.
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : (JSON.stringify(v) ?? 'null')

export const actionKey = (name: string, input: unknown): string => `${name}:${stable(input)}`

const UNKNOWN_NOTE =
  "It was already sent, so it may or may not have taken effect. Don't repeat it without checking first or asking the user."

// What the model is told about one call.
function resultText(r: ActionRecord): string {
  const said = r.result ?? ''
  switch (r.status) {
    case 'not-run':
      return `Not run: ${said || 'nothing was done.'}`
    case 'unknown':
      return `Outcome unknown: ${said ? `${said} ` : ''}${UNKNOWN_NOTE}`
    default:
      return said
  }
}

const finalStatus = (r: ToolRun): ActionStatus => r.outcome ?? (r.isError ? 'failed' : 'completed')

export class TurnLog {
  readonly startLength: number
  private round: Call[] | null = null
  private partial = ''
  // Anything beyond the user's message: text, tool calls.
  private happened = false

  constructor(
    readonly conversation: Conversation,
    private readonly save: (c: Conversation) => void
  ) {
    this.startLength = conversation.messages.length
  }

  private get actions(): Record<string, ActionRecord> {
    return (this.conversation.actions ??= {})
  }

  // Text streamed in the current model step, kept if the step never finishes.
  text(delta: string): void {
    this.partial += delta
  }

  addAssistant(content: BetaContentBlockParam[]): void {
    this.partial = ''
    if (content.length) {
      this.conversation.messages.push({ role: 'assistant', content })
      this.happened = true
    }
    this.save(this.conversation)
  }

  // An earlier call with the same name and input whose outcome is unknown,
  // in this chat or in the chats it continues.
  unknownRepeat(c: Call): boolean {
    const key = actionKey(c.name, c.input)
    return (
      Object.entries(this.actions).some(
        ([id, a]) => id !== c.id && a.key === key && a.status === 'unknown'
      ) || !!this.conversation.continuedFrom?.unknown.some((u) => u.key === key)
    )
  }

  // Runs a round of tool calls from the assistant message just added, one at
  // a time. Each call's progress is saved before the next one starts; after a
  // stop, the rest are marked not run and never start.
  async runRound(
    calls: Call[],
    run: (c: Call) => Promise<ToolRun>,
    signal: AbortSignal,
    onSettled?: (c: Call, status: ActionStatus) => void
  ): Promise<BetaToolResultBlockParam[]> {
    this.round = calls
    this.happened = true
    for (const c of calls)
      this.actions[c.id] = {
        name: c.name,
        label: c.label,
        write: c.write,
        status: 'pending',
        key: actionKey(c.name, c.input)
      }
    this.save(this.conversation)
    for (const c of calls) {
      if (signal.aborted) {
        this.settle(c, {
          content: 'Stopped before it started, so nothing was done.',
          isError: true,
          outcome: 'not-run'
        })
        onSettled?.(c, 'not-run')
        continue
      }
      this.actions[c.id].status = 'running'
      this.save(this.conversation)
      let r: ToolRun
      try {
        r = await run(c)
      } catch (err) {
        // A failure in the tool code itself: a write may have got part way.
        r = {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
          outcome: c.write ? 'unknown' : 'failed'
        }
      }
      this.settle(c, r)
      onSettled?.(c, this.actions[c.id].status)
    }
    return this.closeRound()
  }

  private settle(c: Call, r: ToolRun): void {
    const a = this.actions[c.id]
    a.status = finalStatus(r)
    a.result = r.content
    this.save(this.conversation)
  }

  // One result per call of the open round, plus an optional note for the model.
  private closeRound(note?: string): BetaToolResultBlockParam[] {
    const calls = this.round ?? []
    this.round = null
    const results: BetaToolResultBlockParam[] = calls.map((c) => {
      const a = this.actions[c.id]
      return {
        type: 'tool_result',
        tool_use_id: c.id,
        content: resultText(a),
        is_error: a.status !== 'completed'
      }
    })
    const content: (BetaToolResultBlockParam | { type: 'text'; text: string })[] = [...results]
    if (note) content.push({ type: 'text', text: note })
    this.conversation.messages.push({ role: 'user', content })
    this.save(this.conversation)
    return results
  }

  // A round left open in a saved chat, to be closed by interrupt().
  adoptOpenRound(calls: Call[]): void {
    this.round = calls
    this.happened = true
  }

  notice(kind: NoticeKind, text: string): void {
    ;(this.conversation.notices ??= []).push({
      after: this.conversation.messages.length,
      kind,
      text
    })
    this.save(this.conversation)
  }

  // The turn stopped early. Keeps everything that happened and adds a notice;
  // returns false (and puts the history back as it was before the user's
  // message) only when nothing happened at all. The log must be created
  // before the user's message is added.
  interrupt(kind: NoticeKind, text: string): boolean {
    if (this.round) {
      for (const c of this.round) {
        const a = this.actions[c.id]
        if (a.status === 'pending')
          this.settle(c, {
            content: 'Stopped before it started, so nothing was done.',
            isError: true,
            outcome: 'not-run'
          })
        else if (a.status === 'running')
          this.settle(c, {
            content: 'Interrupted while running.',
            isError: true,
            outcome: c.write ? 'unknown' : 'failed'
          })
      }
      this.closeRound(`[Custard: ${text}]`)
    }
    if (this.partial.trim()) {
      this.conversation.messages.push({ role: 'assistant', content: this.partial.trimEnd() })
      this.partial = ''
      this.happened = true
    }
    if (!this.happened) {
      this.conversation.messages.length = this.startLength
      return false
    }
    this.notice(kind, text)
    return true
  }
}

const isToolResults = (m: Conversation['messages'][number] | undefined): boolean =>
  !!m && typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result')

// A chat saved in the middle of a turn (Custard quit or crashed). Closes the
// open round from the saved records, the same way a stop would, so the
// history is valid again. Returns true if it changed anything.
export function repairInterrupted(c: Conversation): boolean {
  const last = c.messages[c.messages.length - 1]
  const closed = (c.notices ?? []).some((n) => n.after === c.messages.length)
  const text = 'Custard closed before this turn finished.'
  if (last?.role === 'assistant' && typeof last.content !== 'string') {
    const uses = last.content.filter((b) => b.type === 'tool_use')
    if (!uses.length) return false
    const log = new TurnLog(c, () => undefined)
    const calls: Call[] = uses.map((u) => {
      const a = c.actions?.[u.id]
      return {
        id: u.id,
        name: u.name,
        input: u.input,
        label: a?.label ?? u.name,
        write: a?.write ?? true
      }
    })
    const actions = (c.actions ??= {})
    for (const call of calls)
      actions[call.id] ??= {
        name: call.name,
        label: call.label,
        write: call.write,
        status: 'pending',
        key: actionKey(call.name, call.input)
      }
    log.adoptOpenRound(calls)
    log.interrupt('interrupted', text)
    return true
  }
  // Closed between rounds, before the model's next reply.
  if (isToolResults(last) && !closed) {
    ;(c.notices ??= []).push({ after: c.messages.length, kind: 'interrupted', text })
    return true
  }
  return false
}
