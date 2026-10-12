import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

// Plain-language provider errors.
export function describeError(err: unknown, provider: string): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError)
    return `Your ${provider} API key was rejected. Check it in Settings.`
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) {
    const after = Number(err.headers?.get?.('retry-after'))
    return `${provider} is limiting requests right now.${after > 0 ? ` Try again in ${Math.ceil(after)} seconds.` : ' Try again shortly.'}`
  }
  if (
    err instanceof Anthropic.APIConnectionTimeoutError ||
    err instanceof OpenAI.APIConnectionTimeoutError
  )
    return `${provider} took too long to answer.`
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError)
    return `Couldn't reach ${provider}. Check your internet connection.`
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    if (err.status === 529 || err.status === 503)
      return `${provider} is overloaded right now. Try again shortly.`
    return `${provider} returned an error${err.status ? ` (${err.status})` : ''}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
