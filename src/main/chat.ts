import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  MessageCreateParamsStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { ipcMain, type WebContents } from 'electron'
import { getApiKey } from './apiKey'
import { getConversation, newConversation, saveConversation } from './store'
import { chatModels, type ChatEvent, type Conversation, type SendChatRequest } from '../shared/chat'

const SYSTEM_PROMPT =
  'You are Claude, chatting with the user through Custard, their personal desktop client. ' +
  'Format responses in Markdown when it helps readability.'

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
  const emit = (e: ChatEvent): void => {
    if (!sender.isDestroyed()) sender.send('chat:event', e)
  }
  const apiKey = getApiKey()
  if (!apiKey) {
    emit({
      requestId: req.requestId,
      type: 'error',
      message: 'Add your API key in Settings first.',
      conversation: null
    })
    return
  }

  const conversation: Conversation =
    (req.conversationId && getConversation(req.conversationId)) || newConversation(req.text)
  conversation.messages.push({ role: 'user', content: req.text })

  const model = chatModels.find((m) => m.id === req.settings.model) ?? chatModels[0]
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    messages: conversation.messages,
    cache_control: { type: 'ephemeral' },
    stream: true
  }
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
  running.set(req.requestId, controller)
  const client = new Anthropic({ apiKey })
  let partialText = ''

  // A failed turn is removed from the end of the history so it can be resent.
  const fail = (message: string): void => {
    conversation.messages.pop()
    if (conversation.messages.length > 0) saveConversation(conversation)
    emit({
      requestId: req.requestId,
      type: 'error',
      message,
      conversation: conversation.messages.length > 0 ? conversation : null
    })
  }

  try {
    const stream = client.beta.messages.stream(params, { signal: controller.signal })
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
        const { from, to } = event.content_block
        emit({ requestId: req.requestId, type: 'fallback', from: from.model, to: to.model })
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'thinking_delta') {
          emit({ requestId: req.requestId, type: 'thinking', text: event.delta.thinking })
        } else if (event.delta.type === 'text_delta') {
          partialText += event.delta.text
          emit({ requestId: req.requestId, type: 'text', text: event.delta.text })
        }
      }
    }
    const message = await stream.finalMessage()
    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category
      fail(`Claude declined this request${category ? ` (${category})` : ''}.`)
      return
    }
    conversation.messages.push({ role: 'assistant', content: echoableContent(message.content) })
    saveConversation(conversation)
    emit({ requestId: req.requestId, type: 'done', conversation })
  } catch (err) {
    if (controller.signal.aborted) {
      // Stopped by the user: keep what was written so far as plain text.
      if (partialText.trim()) {
        conversation.messages.push({ role: 'assistant', content: partialText.trimEnd() })
        saveConversation(conversation)
        emit({ requestId: req.requestId, type: 'done', conversation })
      } else {
        fail('Stopped.')
      }
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
    running.delete(req.requestId)
  }
}

export function registerChatHandlers(): void {
  ipcMain.on('chat:send', (e, req: SendChatRequest) => void send(e.sender, req))
  ipcMain.on('chat:stop', (_, requestId: string) => running.get(requestId)?.abort())
}
