import type { JsonSchema } from '../../shared/plugins'

// A deliberately small subset of JSON Schema: enough for tool inputs, and
// small enough that what the host enforces is exactly what is documented.

const KEYWORDS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems'
])
const TYPES = new Set(['object', 'string', 'integer', 'number', 'boolean', 'array'])

// Problems with a schema itself, so a manifest can be rejected before use.
export function checkSchema(schema: unknown, at = 'schema', depth = 0): string[] {
  if (depth > 8) return [`${at}: nested too deeply`]
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return [`${at}: must be an object`]
  const s = schema as Record<string, unknown>
  const errors: string[] = []
  for (const k of Object.keys(s))
    if (!KEYWORDS.has(k)) errors.push(`${at}: "${k}" is not supported`)
  if (s.type !== undefined && !TYPES.has(s.type as string))
    errors.push(`${at}: unknown type ${JSON.stringify(s.type)}`)
  if (s.type === undefined) errors.push(`${at}: "type" is required`)
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== 'string' || s.pattern.length > 200)
      errors.push(`${at}: pattern must be a short string`)
    else
      try {
        new RegExp(s.pattern, 'u')
      } catch {
        errors.push(`${at}: pattern is not a valid regular expression`)
      }
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0))
    errors.push(`${at}: enum must be a non-empty array`)
  if (s.required !== undefined && !Array.isArray(s.required))
    errors.push(`${at}: required must be an array`)
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== 'object')
      errors.push(`${at}: properties must be an object`)
    else
      for (const [k, v] of Object.entries(s.properties))
        errors.push(...checkSchema(v, `${at}.${k}`, depth + 1))
  }
  if (s.items !== undefined) errors.push(...checkSchema(s.items, `${at}[]`, depth + 1))
  return errors
}

const typeOf = (v: unknown): string =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'array'
      : typeof v === 'number' && Number.isInteger(v)
        ? 'integer'
        : typeof v

// Errors for a value, as short lines a model can act on. Empty means valid.
export function validate(schema: JsonSchema, value: unknown, at = 'input'): string[] {
  const t = typeOf(value)
  const want = schema.type
  if (want === 'number' ? t !== 'number' && t !== 'integer' : want && t !== want)
    return [`${at} must be ${want === 'integer' ? 'an integer' : `a ${want}`}`]
  const errors: string[] = []
  if (schema.enum && !schema.enum.includes(value as string | number))
    errors.push(`${at} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${at} is too short`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${at} is too long (max ${schema.maxLength})`)
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
      errors.push(`${at} has the wrong format`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${at} must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${at} must be at most ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${at} needs at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${at} allows at most ${schema.maxItems} items`)
    if (schema.items)
      value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${at}[${i}]`)))
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    for (const k of schema.required ?? [])
      if (obj[k] === undefined) errors.push(`${at}.${k} is required`)
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k]
      if (sub) errors.push(...validate(sub, v, `${at}.${k}`))
      else if (schema.additionalProperties === false) errors.push(`${at}.${k} is not allowed`)
    }
  }
  return errors
}
