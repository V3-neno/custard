import type { ConfigValue, FetchInit, PluginContext, PluginResponse } from './index'

// Test helpers for plugins: a fake context with a scripted fetch, and a tiny
// test runner. The same test files run in Custard's sandbox (Validate & test)
// and under vitest in this repo.

export type FetchCall = { url: string; init: FetchInit }
export type FakeFetch = (url: string, init: FetchInit) => PluginResponse | Promise<PluginResponse>

export function response(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {}
): PluginResponse {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    text: async () => text,
    json: async <T>() => JSON.parse(text) as T
  }
}

export type TestContext = PluginContext & {
  calls: FetchCall[]
  opened: string[]
  logs: string[]
  data: Map<string, unknown>
}

export function createContext(
  o: { fetch?: FakeFetch; config?: Record<string, ConfigValue>; signal?: AbortSignal } = {}
): TestContext {
  const calls: FetchCall[] = []
  const opened: string[] = []
  const logs: string[] = []
  const data = new Map<string, unknown>()
  return {
    calls,
    opened,
    logs,
    data,
    signal: o.signal ?? new AbortController().signal,
    config: o.config ?? {},
    fetch: async (url, init = {}) => {
      calls.push({ url, init })
      if (!o.fetch) throw new Error(`Unexpected request to ${url}`)
      return o.fetch(url, init)
    },
    storage: {
      get: async <T>(k: string) => data.get(k) as T | undefined,
      set: async (k, v) => void data.set(k, JSON.parse(JSON.stringify(v))),
      delete: async (k) => void data.delete(k)
    },
    openExternal: async (url) => void opened.push(url),
    log: (m) => void logs.push(m)
  }
}

type Case = { name: string; fn: () => unknown | Promise<unknown> }
const registry: Case[] = ((globalThis as Record<string, unknown>).__custardTests ??= []) as Case[]

export function test(name: string, fn: () => unknown | Promise<unknown>): void {
  registry.push({ name, fn })
}

export class AssertionError extends Error {}

const show = (v: unknown): string => {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const assert = Object.assign(
  (cond: unknown, message = 'Assertion failed'): void => {
    if (!cond) throw new AssertionError(message)
  },
  {
    equal(actual: unknown, expected: unknown, message?: string): void {
      if (actual !== expected)
        throw new AssertionError(message ?? `Expected ${show(expected)}, got ${show(actual)}`)
    },
    deepEqual(actual: unknown, expected: unknown, message?: string): void {
      if (show(actual) !== show(expected))
        throw new AssertionError(message ?? `Expected ${show(expected)}, got ${show(actual)}`)
    },
    match(actual: string, pattern: RegExp, message?: string): void {
      if (!pattern.test(actual))
        throw new AssertionError(message ?? `Expected ${show(actual)} to match ${pattern}`)
    },
    notMatch(actual: string, pattern: RegExp, message?: string): void {
      if (pattern.test(actual))
        throw new AssertionError(message ?? `Expected ${show(actual)} not to match ${pattern}`)
    }
  }
)

// A test that never settles fails after this long, and the rest still run.
const TEST_LIMIT_MS = 10_000

type Outcome = { name: string; ok: boolean; error?: string; ms?: number; skipped?: true }

// Used by the host's sandboxed test run. `filter` runs only the tests whose
// name contains it (case-insensitive); the others come back as skipped. The
// host's sandbox sets __custardEmit, and gets a line as each test starts and
// finishes, so a run it has to stop (a test stuck in a loop never answers) can
// still report what passed before it and which test was running.
export async function runRegisteredTests(filter?: string | null): Promise<Outcome[]> {
  const results: Outcome[] = []
  const emit = (line: unknown): void => {
    const f = (globalThis as { __custardEmit?: (s: string) => void }).__custardEmit
    if (typeof f === 'function') f(JSON.stringify(line))
  }
  const want = filter ? String(filter).toLowerCase() : ''
  for (const t of registry) {
    if (want && !t.name.toLowerCase().includes(want)) {
      results.push({ name: t.name, ok: true, skipped: true })
      continue
    }
    emit({ start: t.name })
    const start = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(t.fn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Took longer than ${TEST_LIMIT_MS / 1000} seconds.`)),
            TEST_LIMIT_MS
          )
        })
      ])
      results.push({ name: t.name, ok: true, ms: Date.now() - start })
      emit({ done: results[results.length - 1] })
    } catch (err) {
      results.push({
        name: t.name,
        ok: false,
        error: String((err as Error)?.message ?? err),
        ms: Date.now() - start
      })
      emit({ done: results[results.length - 1] })
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

export const registeredTests = (): readonly Case[] => registry
