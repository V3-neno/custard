import { getApiKey } from '../apiKey'
import { adapterFor } from '../adapters/registry'
import { describeError } from '../providerError'
import { chatModels, providerNames } from '../../shared/chat'
import type { Step } from './run'
import { charge } from '../store'

// One model call per step, through the model's provider adapter
// (adapter.sendMessage), not streamed to anyone, with no retry of its own:
// a rate limit or a rejected key ends the run with the reason, and the
// schedule decides what happens next. Claude waits for its reply over a
// stream, as long replies need; a Responses provider sends one plain request
// with no output limit. What a reply means for the run is the same for every
// provider:
//   - declined, or the context window filled: the run ends with the reason
//   - cut off while calling a tool: the run ends and the call is not run
//   - cut off with text only: the text is the step's answer
//   - the provider couldn't finish: the run ends with its reason

export function stepFor(modelId: string): Step | string {
  const model = chatModels.find((m) => m.id === modelId)
  if (!model) return `The model ${modelId} isn't one Custard offers any more. Pick another.`
  const apiKey = getApiKey(model.provider)
  if (!apiKey)
    return `There is no ${providerNames[model.provider]} API key saved. Add it in Settings.`
  const adapter = adapterFor(model.provider)
  const provider = providerNames[model.provider]
  return async ({ system, messages, tools, signal }) => {
    let r
    try {
      r = await adapter.sendMessage({
        model: model.id,
        apiKey,
        system,
        messages,
        tools,
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
    return { text: r.text, calls: r.calls }
  }
}
