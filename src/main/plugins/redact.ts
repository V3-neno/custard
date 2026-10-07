// Removes secrets from anything a plugin produces before it reaches the
// model, the UI or a log: the plugin's own secret values and account tokens,
// plus anything that looks like a bearer token or a token field.

const PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [
    /("?(?:access_token|refresh_token|id_token|client_secret|api_key|apikey|password)"?\s*[:=]\s*"?)[^"&\s,}]+/gi,
    '$1[redacted]'
  ]
]

export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]')
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out
}
