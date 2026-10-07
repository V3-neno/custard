import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  MessageCreateParamsStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { ipcMain, type WebContents } from 'electron'
import { existsSync } from 'fs'
import { getApiKey } from './apiKey'
import { getConversation, getVaultPath, newConversation, saveConversation } from './store'
import { runVaultTool, vaultSystemPrompt, vaultTools } from './vault'
import {
  chatModels,
  type ChatEvent,
  type Conversation,
  type Mode,
  type SendChatRequest
} from '../shared/chat'
import { toolLabel } from '../shared/vault'

const SYSTEM_PROMPT =
  'You are Claude, working with the user through Custard, their personal desktop client. ' +
  'Format responses in Markdown when it helps readability.'

// Each mode keeps its own history and nudges Claude toward that kind of work.
const MODE_PROMPTS: Record<Mode, string> = {
  chat: 'The user is in Chat mode: a general conversation.',
  code:
    'The user is in Code mode. Act as a senior software engineer: give complete, working code in fenced blocks with the language named, ' +
    'explain the reasoning briefly, and point out bugs, edge cases and trade-offs. The user mostly works in TypeScript, Next.js and Electron on Windows.',
  design:
    'The user is in Design mode. Act as a product and visual designer: think about layout, hierarchy, color, typography, spacing and interaction states. ' +
    'When showing UI, give self-contained HTML with inline CSS (or React with Tailwind when asked) in fenced code blocks, and describe the design choices.'
}

// Upper bound on model calls per user message, so a tool loop can't run away.
const MAX_STEPS = 25

const running = new Map<string, AbortController>()

// After a mid-answer fallback, blocks the declining model produced before the
// last `fallback` marker (other than text) must not be sent back to the API.
function echoableContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const boundary = content.map((b) => b.type).lastIndexOf('fallback')
  return content.filter(
    (b, i) =>
      i >= boundary ||
      !(b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'tool_use')
  ) as BetaContentBlockParam[]
}

async function send(sender: WebContents, req: SendChatRequest): Promise<void> {
  const { requestId } = req
  const emit = (e: ChatEvent): void => {
    if (!sender.isDestroyed()) sender.send('chat:event', e)
  }
  const apiKey = getApiKey()
  if (!apiKey) {
    emit({
      requestId,
      type: 'error',
      message: 'Add your API key in Settings first.',
      conversation: null
    })
    return
  }

  const conversation: Conversation =
    (req.conversationId && getConversation(req.conversationId)) ||
    newConversation(req.mode, req.text)
  const startLength = conversation.messages.length
  conversation.messages.push({ role: 'user', content: req.text })

  const vault = getVaultPath()
  const vaultReady = vault !== null && existsSync(vault)
  const system: BetaTextBlockParam[] = [
    { type: 'text', text: `${SYSTEM_PROMPT}\n\n${MODE_PROMPTS[conversation.mode]}` }
  ]
  if (vaultReady) system.push({ type: 'text', text: vaultSystemPrompt(vault) })

  const model = chatModels.find((m) => m.id === req.settings.model) ?? chatModels[0]
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    max_tokens: 64000,
    system,
    messages: conversation.messages,
    cache_control: { type: 'ephemeral' },
    stream: true
  }
  // The API requires tool definitions whenever the history contains tool
  // calls, so keep them even if the vault was disconnected since.
  const usedTools = conversation.messages.some(
    (m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_use')
  )
  if (vaultReady || usedTools) params.tools = vaultTools
  if (model.effort) {
    params.thinking = { type: 'adaptive', display: 'summarized' }
    params.output_config = { effort: req.settings.effort }
  }
  if (model.fallbacks) {
    // If a safety classifier declines, the API retries on Anthropic's
    // recommended fallback model instead of returning a refusal.
    params.betas = ['server-side-fallback-2026-07-01']
    params.fallbacks = 'default'
  }

  const controller = new AbortController()
  running.set(requestId, controller)
  const client = new Anthropic({ apiKey })
  let partialText = ''

  // A failed turn is removed from the end of the history so it can be resent.
  const fail = (message: string): void => {
    conversation.messages.length = startLength
    if (startLength > 0) saveConversation(conversation)
    emit({ requestId, type: 'error', message, conversation: startLength > 0 ? conversation : null })
  }

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const stream = client.beta.messages.stream(params, { signal: controller.signal })
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
          const { from, to } = event.content_block
          emit({ requestId, type: 'fallback', from: from.model, to: to.model })
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'thinking_delta') {
            emit({ requestId, type: 'thinking', text: event.delta.thinking })
          } else if (event.delta.type === 'text_delta') {
            partialText += event.delta.text
            emit({ requestId, type: 'text', text: event.delta.text })
          }
        }
      }
      const message = await stream.finalMessage()
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category
        fail(`Claude declined this request${category ? ` (${category})` : ''}.`)
        return
      }
      const toolUses = message.content.filter((b) => b.type === 'tool_use')
      if (toolUses.length > 0 && message.stop_reason === 'max_tokens') {
        fail('The reply was cut off in the middle of a vault action. Try again.')
        return
      }
      conversation.messages.push({ role: 'assistant', content: echoableContent(message.content) })
      if (message.stop_reason !== 'tool_use') break

      // Run every tool call from this turn and return all results together.
      const results: BetaToolResultBlockParam[] = toolUses.map((t) => {
        const label = toolLabel(t.name, t.input)
        emit({ requestId, type: 'tool', id: t.id, label, status: 'running' })
        const r = vaultReady
          ? runVaultTool(vault, t.name, t.input)
          : { content: 'The vault is not connected right now.', isError: true }
        emit({ requestId, type: 'tool', id: t.id, label, status: r.isError ? 'error' : 'done' })
        return { type: 'tool_result', tool_use_id: t.id, content: r.content, is_error: r.isError }
      })
      conversation.messages.push({ role: 'user', content: results })
      saveConversation(conversation)
    }
    saveConversation(conversation)
    emit({ requestId, type: 'done', conversation })
  } catch (err) {
    const onlyUserMessage = conversation.messages.length === startLength + 1
    if (controller.signal.aborted && onlyUserMessage && partialText.trim()) {
      // Stopped by the user before any vault actions: keep the text so far.
      conversation.messages.push({ role: 'assistant', content: partialText.trimEnd() })
      saveConversation(conversation)
      emit({ requestId, type: 'done', conversation })
    } else if (controller.signal.aborted) {
      fail('Stopped.')
    } else if (err instanceof Anthropic.AuthenticationError) {
      fail('Your API key was rejected. Check it in Settings.')
    } else if (err instanceof Anthropic.RateLimitError) {
      fail('Rate limited by the API. Try again in a moment.')
    } else if (err instanceof Anthropic.APIError) {
      fail(`API error${err.status ? ` ${err.status}` : ''}: ${err.message}`)
    } else {
      fail(err instanceof Error ? err.message : String(err))
    }
  } finally {
    running.delete(requestId)
  }
}

export function registerChatHandlers(): void {
  ipcMain.on('chat:send', (e, req: SendChatRequest) => void send(e.sender, req))
  ipcMain.on('chat:stop', (_, requestId: string) => running.get(requestId)?.abort())
}
