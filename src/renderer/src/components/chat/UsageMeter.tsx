import { chatModels, type ChatUsage, type ContextUse } from '../../../../shared/chat'
import { formatCost, formatTokens } from '../../../../shared/pricing'

// Beside the model pills: how full the chat's context is, and what the chat
// has cost so far. Both are estimates; the tooltip says what they count.

type Props = { usage?: ChatUsage; context?: ContextUse }

function UsageMeter({ usage, context }: Props): React.JSX.Element | null {
  if (!usage && !context) return null
  const share = context && context.budget > 0 ? Math.min(1, context.tokens / context.budget) : 0
  const pct = Math.round(share * 100)
  const model = chatModels.find((m) => m.id === context?.model)?.label ?? context?.model
  const lines = [
    ...(context
      ? [
          `Context: ${pct}% used, about ${formatTokens(context.tokens)} of the ${formatTokens(context.budget)} tokens ${model} can take here${context.counted ? '' : " (Custard's estimate)"}. Each message sends the whole chat again, so a fuller chat costs more per message.`
        ]
      : []),
    ...(usage
      ? [
          `This chat so far: ${formatCost(usage.cost)} estimated, from ${usage.calls} model ${usage.calls === 1 ? 'call' : 'calls'}: ${formatTokens(usage.input + usage.cacheWrite + usage.cacheRead)} tokens in (${formatTokens(usage.cacheRead)} from cache), ${formatTokens(usage.output)} out${usage.webSearches ? `, ${usage.webSearches} web ${usage.webSearches === 1 ? 'search' : 'searches'}` : ''}. Includes Custard's summaries of this chat.`,
          ...(usage.unpriced
            ? [
                `${usage.unpriced} ${usage.unpriced === 1 ? 'call was' : 'calls were'} to a model with no known price and ${usage.unpriced === 1 ? "isn't" : "aren't"} counted.`
              ]
            : [])
        ]
      : []),
    'Estimated from the providers’ published prices; your bill is what counts.'
  ]
  // Amber from where the chat starts saying it is getting long.
  const bar = context?.warn ? 'bg-ember-600' : 'bg-molten-400'
  return (
    <div
      className="flex items-center gap-2 rounded-full border border-forge-700 px-3 py-1 text-xs text-ash-400"
      title={lines.join('\n\n')}
      aria-label="Chat usage"
      data-usage-meter
    >
      {context && (
        <span className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-10 overflow-hidden rounded-full bg-forge-800"
            role="meter"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <span className={`block h-full ${bar}`} style={{ width: `${Math.max(pct, 2)}%` }} />
          </span>
          <span data-context-pct>{pct}%</span>
        </span>
      )}
      {usage && <span data-chat-cost>{formatCost(usage.cost)}</span>}
    </div>
  )
}

export default UsageMeter
