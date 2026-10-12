import Anthropic from '@anthropic-ai/sdk'
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import OpenAI from 'openai'
import type { FunctionTool } from 'openai/resources/responses/responses'
import { getApiKey } from '../apiKey'
import { anthropicEndpoint, openaiEndpoint } from '../endpoints'
import { toBlocks, toInput } from '../openai'
import { describeError } from '../providerError'
import { chatModels, providerNames } from '../../shared/chat'
import type { Step, StepResult } from './run'

// One model call per step, not streamed to anyone, with no retry of its own:
// a rate limit or a rejected key ends the run with the reason, and the
// schedule decides what happens next. The other provider's SDK retries are
// off for the same reason.

const fail = (err: unknown, provider: string): never => {
  throw new Error(describeError(err, provider))
}

function claudeStep(modelId: string, apiKey: string): Step {
  const provider = providerNames.claude
  return async ({ system, messages, tools, signal }) => {
    const client = new Anthropic({ apiKey, maxRetries: 0, ...anthropicEndpoint() })
    let message
    try {
      message = await client.beta.messages
        .stream(
          {
            model: modelId,
            max_tokens: 16000,
            system,
            messages,
            ...(tools.length ? { tools } : {})
          },
          { signal }
        )
        .finalMessage()
    } catch (err) {
      return fail(err, provider)
    }
    if (message.stop_reason === 'refusal') throw new Error('Claude declined this request.')
    const calls = message.content.flatMap((b) =>
      b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []
    )
    if (message.stop_reason === 'max_tokens' && calls.length)
      throw new Error('The answer was cut off while it was calling a tool, so nothing was run.')
    if (message.stop_reason === 'model_context_window_exceeded')
      throw new Error('The run got too long for the model.')
    return {
      text: message.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
      calls
    } satisfies StepResult
  }
}

const toFunctionTool = (t: BetaTool): FunctionTool => ({
  type: 'function',
  name: t.name,
  description: t.description ?? null,
  parameters: t.input_schema as Record<string, unknown>,
  strict: false
})

function openaiStep(modelId: string, apiKey: string): Step {
  const provider = providerNames.openai
  return async ({ system, messages, tools, signal }) => {
    const client = new OpenAI({ apiKey, maxRetries: 0, ...openaiEndpoint() })
    let response
    try {
      response = await client.responses.create(
        {
          model: modelId,
          instructions: system,
          input: toInput(messages),
          store: false,
          ...(tools.length ? { tools: tools.map(toFunctionTool) } : {})
        },
        { signal }
      )
    } catch (err) {
      return fail(err, provider)
    }
    if (response.status === 'incomplete')
      throw new Error('The answer was cut off, so nothing more was run.')
    if (response.status === 'failed')
      throw new Error(
        `${provider} could not finish this: ${response.error?.message ?? 'unknown error'}`
      )
    const blocks = toBlocks(response.output)
    return {
      text: blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''),
      calls: blocks.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []
      )
    }
  }
}

// The step for a model id, or why there can't be one.
export function stepFor(modelId: string): Step | string {
  const model = chatModels.find((m) => m.id === modelId)
  if (!model) return `The model ${modelId} isn't one Custard offers any more. Pick another.`
  const key = getApiKey(model.provider)
  if (!key) return `There is no ${providerNames[model.provider]} API key saved. Add it in Settings.`
  return model.provider === 'claude' ? claudeStep(model.id, key) : openaiStep(model.id, key)
}
