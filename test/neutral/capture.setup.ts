import { appendFileSync } from 'fs'
import { expect, vi } from 'vitest'

// TEST ONLY, used by test/neutral/capture.config.ts. Records every history
// the unit tests pass to the functions that turn a stored chat into a
// request, so the neutral-format tests can replay the same histories
// (test/neutral/unit-histories.json). Each wrapper calls the real function.

const OUT = process.env.NEUTRAL_CAPTURE_OUT as string
const file = (expect.getState().testPath ?? '').replace(/^.*\/src\//, 'src/')
const record = (at: string, messages: unknown, extra: Record<string, unknown> = {}): void => {
  try {
    appendFileSync(OUT, JSON.stringify({ file, at, messages, ...extra }) + '\n')
  } catch {
    // A history that can't be written as JSON is left out.
  }
}

vi.mock('../../src/main/attachments/request', async (load) => {
  const real = await load<typeof import('../../src/main/attachments/request')>()
  return {
    ...real,
    withFiles: (m: Parameters<typeof real.withFiles>[0], b: Parameters<typeof real.withFiles>[1]) => {
      record('withFiles', m, { files: [...b.entries()] })
      return real.withFiles(m, b)
    }
  }
})
vi.mock('../../src/main/history', async (load) => {
  const real = await load<typeof import('../../src/main/history')>()
  return {
    ...real,
    withoutUnavailableTools: (
      m: Parameters<typeof real.withoutUnavailableTools>[0],
      a: Set<string>
    ) => {
      record('withoutUnavailableTools', m, { available: [...a] })
      return real.withoutUnavailableTools(m, a)
    }
  }
})
vi.mock('../../src/main/compaction', async (load) => {
  const real = await load<typeof import('../../src/main/compaction')>()
  return {
    ...real,
    claudeHistory: (m: Parameters<typeof real.claudeHistory>[0], model: string) => {
      record('claudeHistory', m, { model })
      return real.claudeHistory(m, model)
    }
  }
})
vi.mock('../../src/main/openai', async (load) => {
  const real = await load<typeof import('../../src/main/openai')>()
  return {
    ...real,
    toInput: (m: Parameters<typeof real.toInput>[0]) => {
      record('toInput', m)
      return real.toInput(m)
    },
    runOpenAI: (t: Parameters<typeof real.runOpenAI>[0]) => {
      record('runOpenAI', t.history, { model: t.model })
      return real.runOpenAI(t)
    }
  }
})
// Chats the tests build for other purposes (memory, continuation, the search
// gate, crash repair) are stored histories too.
vi.mock('../../src/main/memory/evidence', async (load) => {
  const real = await load<typeof import('../../src/main/memory/evidence')>()
  return {
    ...real,
    buildEvidence: (...a: Parameters<typeof real.buildEvidence>) => {
      record('buildEvidence', a[0].messages)
      return real.buildEvidence(...a)
    }
  }
})
vi.mock('../../src/main/web/index', async (load) => {
  const real = await load<typeof import('../../src/main/web/index')>()
  return {
    ...real,
    searchExposure: (...a: Parameters<typeof real.searchExposure>) => {
      record('searchExposure', a[0].messages)
      return real.searchExposure(...a)
    }
  }
})
vi.mock('../../src/main/handoff', async (load) => {
  const real = await load<typeof import('../../src/main/handoff')>()
  return {
    ...real,
    carriedContext: (c: Parameters<typeof real.carriedContext>[0]) => {
      record('carriedContext', c.messages)
      return real.carriedContext(c)
    }
  }
})
vi.mock('../../src/main/turn', async (load) => {
  const real = await load<typeof import('../../src/main/turn')>()
  class TurnLog extends real.TurnLog {
    constructor(...a: ConstructorParameters<typeof real.TurnLog>) {
      super(...a)
      record('TurnLog', a[0].messages)
    }
  }
  return {
    ...real,
    TurnLog,
    repairInterrupted: (c: Parameters<typeof real.repairInterrupted>[0]) => {
      record('repairInterrupted', c.messages)
      const changed = real.repairInterrupted(c)
      record('repairInterrupted:after', c.messages)
      return changed
    }
  }
})
