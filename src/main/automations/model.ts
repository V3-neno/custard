import { getApiKey } from '../apiKey'
import { adapterFor } from '../adapters/registry'
import { describeError } from '../providerError'
import { providerNames } from '../../shared/chat'
import { profileOf, type Effort } from '../../shared/models'
import { providers } from '../../shared/providers'
import type { Step } from './run'
import { charge } from '../store'

// One model call per step, through the model's provider adapter
// (adapter.sendMessage), not streamed to anyone, with no retry of its own:
// a rate limit or a rejected key ends the run with the reason, and the
// schedule decides what happens next. Claude waits for its reply over a
// stream, as long replies need, with an output limit of CLAUDE_STEP_TOKENS
// (thinking and text together); a Responses provider sends one plain request
// with no output limit. The automation's effort, when it has one, goes to the
// adapter, which sends what the model's profile says for it (none for a model
// that takes none). What a reply means for the run is the same for every
// provider:
//   - declined, or the context window filled: the run ends with the reason
//   - cut off while calling a tool: the run ends and the call is not run
//   - cut off with text only: the text is the step's answer, and the run's
//     record says it ended early at the output limit (CUT_OFF_REASON)
//   - the provider couldn't finish: the run ends with its reason

// Claude's limit for one step, as a chat turn has: thinking counts toward it.
// Never above the model's own output limit (Haiku 4.5's is exactly this).
export const CLAUDE_STEP_TOKENS = 64_000

export function stepFor(modelId: string, effort?: Effort): Step | string {
  const model = profileOf(modelId)
  if (!model) return `The model ${modelId} isn't one Custard offers any more. Pick another.`
  const apiKey = getApiKey(model.provider)
  if (!apiKey)
    return `There is no ${providerNames[model.provider]} API key saved. Add it in Settings.`
  const adapter = adapterFor(model.provider)
  const provider = providerNames[model.provider]
  const maxTokens =
    providers[model.provider].api === 'anthropic'
      ? Math.min(CLAUDE_STEP_TOKENS, model.limits.maxOutput)
      : undefined
  return async ({ system, messages, tools, signal }) => {
    let r
    try {
      r = await adapter.sendMessage({
        model: model.id,
        apiKey,
        system,
        messages,
        tools,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(effort ? { effort } : {}),
        stream: true,
        retries: 0,
        signal
      })
    } catch (err) {
      throw new Error(describeError(err, provider))
    }
    // Automations belong to no chat: counted for the month only.
    for (const part of r.usage) charge(null, part.model, part.usage)
    if (r.stop === 'refused') throw new Error(`${provider} declined this request.`)
    if (r.stop === 'too-long') throw new Error('The run got too long for the model.')
    if (r.stop === 'failed') throw new Error(`${provider} could not finish this: ${r.error}`)
    if (r.stop === 'cut-off' && r.calls.length)
      throw new Error('The answer was cut off while it was calling a tool, so nothing was run.')
    return { text: r.text, calls: r.calls, ...(r.stop === 'cut-off' ? { cutOff: true } : {}) }
  }
}
