import fs from 'fs'
import http from 'http'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capabilities } from '../shared/adapter'
import {
  apiOf,
  chatModels,
  defaultChatSettings,
  effortChoices,
  efforts,
  introduce,
  providerOf,
  shownEffort,
  type Effort
} from '../shared/chat'
import { costOf, noUsage } from '../shared/pricing'
import { providerIds } from '../shared/providers'
import { capabilitiesOf, modelInfo } from './adapters/capabilities'
import { adapterFor } from './adapters/registry'
import { imageTokens, kindRefusal, pdfTokens } from './attachments/request'
import { budgetFor, CONTEXT_LIMITS, compactTrigger, limitsFor, maxResultChars } from './context'
import { HANDOFF_MODELS } from './handoff'
import { SUMMARY_MODELS } from './memory/summarize'
import { webTools } from './web'
import { claudeSearchTool, searchClaude } from './web/search'

// Model profiles (Workstream A, Phase A2): everything the per-model tables
// produced, recorded on the code before the profiles replaced them
// (a8ec2e7 + the A1 commit). The refactor must leave every value identical.
// UPDATE_GOLDEN=1 rewrites the fixtures; only ever on the code before a
// change.

const update = process.env.UPDATE_GOLDEN === '1'
const fixture = (name: string): string => join(__dirname, '__golden__', name)
function golden(name: string, actual: unknown): void {
  const json = JSON.parse(JSON.stringify(actual))
  if (update) {
    fs.mkdirSync(join(__dirname, '__golden__'), { recursive: true })
    fs.writeFileSync(fixture(name), JSON.stringify(json, null, 1) + '\n')
    return
  }
  expect(json).toEqual(JSON.parse(fs.readFileSync(fixture(name), 'utf8')))
}

const ids = chatModels().map((m) => m.id)
// A model a provider lists that Custard has no profile for.
const UNKNOWN = 'deepseek-v5-preview'

const usage = { ...noUsage(), input: 1000, cacheWrite: 200, cacheRead: 300, output: 400 }
const longUsage = { ...usage, input: 300_000, webSearches: 2 }

// The Responses wire: what reasoning a one-shot call sends, through a
// stand-in that records each body.
const bodies: Record<string, unknown>[] = []
let server: http.Server
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'r',
          object: 'response',
          created_at: 0,
          status: 'completed',
          model: 'm',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}/deepseek`
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/openai/v1`
})
afterAll(() => {
  server.close()
  delete process.env.DEEPSEEK_BASE_URL
  delete process.env.OPENAI_BASE_URL
})

describe('model tables, before and after profiles', () => {
  it('capabilities and model info are unchanged (capability golden)', () => {
    golden(
      'capabilities.json',
      Object.fromEntries(
        [...ids, UNKNOWN].map((id) => [
          id,
          { capabilities: capabilitiesOf(id), info: modelInfo(id) }
        ])
      )
    )
    expect(capabilities.length).toBe(14)
  })

  it('every per-model table gives the same values', () => {
    golden('tables.json', {
      chatModels: chatModels(),
      defaultChatSettings,
      summaryModels: SUMMARY_MODELS,
      handoffModels: HANDOFF_MODELS,
      providers: Object.fromEntries(
        providerIds.map((p) => [
          p,
          {
            effortChoices: effortChoices(p),
            shownEffort: Object.fromEntries(efforts.map((e) => [e, shownEffort(p, e)]))
          }
        ])
      ),
      models: Object.fromEntries(
        [...ids, UNKNOWN].map((id) => {
          const m = chatModels().find((x) => x.id === id) ?? {
            id,
            label: id,
            provider: 'deepseek' as const
          }
          return [
            id,
            {
              provider: providerOf(id),
              api: apiOf(id),
              introduce: introduce(m),
              contextLimits: CONTEXT_LIMITS[id] ?? null,
              limitsFor: limitsFor(id),
              budget: budgetFor(id),
              compactTrigger: compactTrigger(id),
              maxResultChars: maxResultChars(id),
              cost: costOf(id, usage),
              costLong: costOf(id, longUsage),
              costDated: costOf(`${id}-20261001`, usage),
              claudeSearchTool: claudeSearchTool(id),
              webTools: (({ tools, prompt }) => ({ tools: tools.map((t) => t.name), prompt }))(
                webTools(m)
              ),
              refusal: { image: kindRefusal(m, 'image'), pdf: kindRefusal(m, 'pdf') },
              imageTokens: {
                none: imageTokens(m),
                small: imageTokens(m, 800, 600),
                big: imageTokens(m, 4000, 3000)
              },
              pdfTokens: pdfTokens(m, { pages: 3, bytes: 1 })
            }
          ]
        })
      )
    })
  })

  it('Claude search calls carry the same tool and effort', async () => {
    const seen: Record<string, unknown> = {}
    for (const id of [...ids, UNKNOWN].filter((x) => providerOf(x) === 'claude')) {
      const client = {
        beta: {
          messages: {
            create: async (p: Record<string, unknown>) => {
              seen[id] = { tools: p.tools, output_config: p.output_config ?? null }
              return {
                content: [],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 }
              }
            }
          }
        }
      }
      await searchClaude(client as never, id, 'q', new AbortController().signal)
    }
    golden('claude-search.json', seen)
  })

  it('Responses one-shot calls send the same reasoning effort', async () => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const id of [...ids, UNKNOWN]) {
      const p = providerOf(id)
      if (p === 'claude') continue
      out[id] = {}
      for (const e of [undefined, ...efforts] as (Effort | undefined)[]) {
        bodies.length = 0
        await adapterFor(p).sendMessage({
          model: id,
          apiKey: 'sk-test',
          system: 's',
          messages: 'hi',
          retries: 0,
          ...(e ? { effort: e } : {})
        })
        out[id][e ?? 'none'] = bodies[0]?.reasoning ?? null
      }
    }
    golden('responses-effort.json', out)
  })
})
