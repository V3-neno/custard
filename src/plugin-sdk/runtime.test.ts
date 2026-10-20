import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin } from './index'
import { start } from './runtime'

type Handlers = {
  call(
    callId: string,
    tool: string,
    input: unknown,
    config: Record<string, never>,
    meta?: unknown
  ): Promise<{ content: string; isError: boolean }>
}

// Starts the runtime against a fake host bridge and returns its handlers.
function run(): Handlers {
  let h: Handlers | null = null
  ;(globalThis as Record<string, unknown>).custardPluginHost = {
    register: (x: Handlers) => (h = x),
    cap: async () => ({ ok: true, value: null })
  }
  start(
    definePlugin({
      tools: {
        who: (_i, ctx) => ctx.caller,
        logging: (_i, ctx) => String(ctx.events.enabled)
      }
    })
  )
  return h!
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).custardPluginHost
})

describe('ctx.caller', () => {
  it('is what the host sent', async () => {
    const h = run()
    for (const caller of ['assistant', 'widget', 'automation', 'design'])
      expect((await h.call('1', 'who', {}, {}, { caller })).content).toBe(caller)
  })

  it('is assistant when the host sent nothing or something unknown', async () => {
    const h = run()
    expect((await h.call('1', 'who', {}, {})).content).toBe('assistant')
    expect((await h.call('2', 'who', {}, {}, { caller: 'user' })).content).toBe('assistant')
    expect((await h.call('3', 'who', {}, {}, 'widget')).content).toBe('assistant')
  })
})

describe('ctx.events.enabled', () => {
  it('is true only when the host says so', async () => {
    const h = run()
    expect((await h.call('1', 'logging', {}, {}, { events: true })).content).toBe('true')
    expect((await h.call('2', 'logging', {}, {}, { events: 'yes' })).content).toBe('false')
    expect((await h.call('3', 'logging', {}, {})).content).toBe('false')
  })
})
