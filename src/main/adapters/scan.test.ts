import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ModelCheck } from '../../shared/adapter'
import type { CapabilityScan, MatrixCell, Recommendation } from '../../shared/capabilityScan'
import type { PluginStatus } from '../../shared/plugins'
import { scanCapabilities, type ScanSources } from './scan'

// Settings → Capabilities. The scan reads local rules and files only.

const vault = mkdtempSync(join(tmpdir(), 'custard-scan-'))
cpSync('vault-template', vault, { recursive: true })
afterAll(() => rmSync(vault, { recursive: true, force: true }))

const plugin = (
  id: string,
  name: string,
  tools: string[],
  state: PluginStatus['state'],
  fills?: PluginStatus['fills']
): PluginStatus =>
  ({
    id,
    name,
    state,
    tools: tools.map((t) => ({
      name: t,
      fullName: `${id}__${t}`,
      effect: 'read',
      askEveryTime: false
    })),
    ...(fills ? { fills } : {})
  }) as PluginStatus

const spotify = plugin('spotify', 'Spotify', ['search', 'now_playing'], 'enabled')
const serper = plugin('serper', 'Serper', ['web_search'], 'disabled', [
  { capability: 'web_search', tool: 'web_search' }
])

const scan = (over: Partial<ScanSources> = {}): CapabilityScan =>
  scanCapabilities({ vault, plugins: () => [spotify], checks: () => null, now: () => 42, ...over })

const cell = (s: CapabilityScan, col: string, cap: string): MatrixCell =>
  [...s.providers, ...s.models].find((c) => c.id === col)!.cells[cap as 'text']

describe('inventory', () => {
  const inv = scan().inventory
  const ids = inv.map((i) => i.id)

  it('finds the standard vault and chat tools', () => {
    for (const t of [
      'vault_read',
      'vault_search',
      'vault_create_note',
      'vault_list',
      'vault_append',
      'vault_edit'
    ])
      expect(ids).toContain(`vault:${t}`)
    expect(ids).toContain('chats:chats_search')
    expect(inv.find((i) => i.id === 'vault:vault_read')).toEqual({
      id: 'vault:vault_read',
      name: 'vault_read',
      category: 'vault',
      provider: 'Custard',
      tool: 'vault_read',
      needs: ['tool_use']
    })
  })

  it('finds web tools, with web_search needing web search', () => {
    expect(inv.find((i) => i.id === 'web:web_search')?.needs).toEqual(['tool_use', 'web_search'])
    expect(ids).toContain('web:web_read')
  })

  it('finds installed plugins and their tools, with their state', () => {
    const s = inv.find((i) => i.id === 'plugin:spotify__search')!
    expect(s).toMatchObject({
      category: 'plugin',
      provider: 'Spotify',
      tool: 'spotify__search',
      state: 'enabled'
    })
  })

  it('finds every skill in the vault and the tools it names', () => {
    const recall = inv.find((i) => i.id === 'skill:chat-recall')!
    expect(recall.category).toBe('skill')
    expect(recall.uses).toEqual(expect.arrayContaining(['chats_search', 'vault_search']))
    expect(inv.filter((i) => i.category === 'skill').length).toBe(16)
  })

  it('a skill that names web_search needs web search', () => {
    mkdirSync(join(vault, 'Custard/Skills/news'))
    writeFileSync(
      join(vault, 'Custard/Skills/news/SKILL.md'),
      '---\nname: news\ndescription: News.\n---\nCall web_search; not my_web_search_x.\n'
    )
    const news = scan().inventory.find((i) => i.id === 'skill:news')!
    expect(news.uses).toEqual(['web_search'])
    expect(news.needs).toEqual(['tool_use', 'web_search'])
    rmSync(join(vault, 'Custard/Skills/news'), { recursive: true })
  })

  it('lists features such as Continue (handoff)', () => {
    expect(inv.find((i) => i.id === 'feature:continue')?.needs).toEqual(['json_schema'])
  })

  it('without a vault: no vault tools or skills; a failing plugin list gives no plugins', () => {
    const s = scan({
      vault: null,
      plugins: () => {
        throw new Error('broken')
      }
    })
    expect(
      s.inventory.some((i) => ['vault', 'chats', 'skill', 'plugin'].includes(i.category))
    ).toBe(false)
    expect(s.inventory.some((i) => i.id === 'web:web_read')).toBe(true)
  })
})

describe('matrix, from the code’s rules', () => {
  const s = scan()
  const all = (p: string, caps: string[], state: string): void =>
    caps.forEach((c) => expect(cell(s, p, c).state, `${p} ${c}`).toBe(state))

  it('Claude supports everything Neno listed', () => {
    all(
      'claude',
      [
        'text',
        'vision',
        'tool_use',
        'reasoning',
        'web_search',
        'prompt_caching',
        'compaction',
        'fallbacks'
      ],
      'supported'
    )
    // Haiku 4.5 takes no effort, so Custard doesn't turn on thinking, compaction or fallbacks for it.
    expect(cell(s, 'claude', 'compaction').note).toBe('Opus 5.5 and Sonnet 5.5 only.')
  })

  it('OpenAI: text, vision, tools, structured output, reasoning; no fallbacks', () => {
    all('openai', ['text', 'vision', 'tool_use', 'json_schema', 'reasoning'], 'supported')
    all('openai', ['fallbacks'], 'unsupported')
    // Differs from Neno's expected list: the code caches (provider-side) and compacts on OpenAI.
    all('openai', ['prompt_caching', 'compaction'], 'supported')
  })

  it('DeepSeek: text, vision (Flash), tools, reasoning, effort; no PDFs, web search, compaction or fallbacks', () => {
    all('deepseek', ['text', 'vision', 'tool_use', 'reasoning', 'effort'], 'supported')
    all('deepseek', ['pdf', 'web_search', 'compaction', 'fallbacks'], 'unsupported')
    expect(cell(s, 'deepseek', 'vision').note).toBe('DeepSeek Flash only.')
    // Differs from Neno's expected list: DeepSeek caches on its side without being asked.
    all('deepseek', ['prompt_caching'], 'supported')
  })

  it('has every capability for every provider', () => {
    expect(s.providers.map((p) => p.id)).toEqual(['claude', 'openai', 'deepseek'])
    for (const p of s.providers) expect(Object.keys(p.cells)).toHaveLength(14)
  })
})

describe('evidence tags', () => {
  const s = scan()
  it('live only where a live test was recorded, per model', () => {
    expect(cell(s, 'deepseek-flash', 'vision').evidence).toBe('live')
    expect(cell(s, 'deepseek-flash', 'json_schema').evidence).toBe('live')
    expect(cell(s, 'deepseek-flash', 'text').evidence).toBe('docs')
    expect(cell(s, 'deepseek-v4-pro', 'json_schema').evidence).toBe('docs')
  })

  it('a provider is live only when every model that has it was tested live', () => {
    expect(cell(s, 'deepseek', 'vision').evidence).toBe('live')
    expect(cell(s, 'claude', 'vision').evidence).toBe('docs')
    const js = cell(s, 'deepseek', 'json_schema')
    expect(js.evidence).toBe('docs')
    expect(js.note).toMatch(/live on DeepSeek Flash/)
  })

  it('a model the provider lists that Custard doesn’t know is unknown everywhere', () => {
    const check: ModelCheck = {
      checkedAt: 1,
      result: 'ok',
      models: [
        { id: 'deepseek-flash', label: 'DeepSeek Flash', available: true, source: 'profile' },
        { id: 'deepseek-v5', label: 'DeepSeek V5', available: true, source: 'discovered' }
      ]
    }
    const t = scan({ checks: (p) => (p === 'deepseek' ? check : null) })
    const v5 = t.models.find((m) => m.id === 'deepseek-v5')!
    expect(v5.kind).toBe('discovered')
    expect(Object.values(v5.cells).every((c) => c.state === 'unknown')).toBe(true)
    // It changes neither DeepSeek's column nor its recommendations.
    expect(t.providers).toEqual(scan().providers)
    expect(t.recommendations).toEqual(scan().recommendations)
  })
})

describe('recommendations', () => {
  const rec = (s: CapabilityScan, id: string): Recommendation | undefined =>
    s.recommendations.find((r) => `${r.provider}:${r.capability}` === id)

  it('no plugin available: says so, and what could be built', () => {
    const r = rec(scan(), 'deepseek:web_search')!
    expect(r.text).toBe(
      'DeepSeek lacks web search. No plugin available yet. One could be built with a web search tool (a Serper or Brave Search plugin, say).'
    )
    expect(r.plugin).toBeUndefined()
    expect(r.affects).toContain('web_search')
    expect(rec(scan(), 'deepseek:pdf')!.text).toMatch(
      /^DeepSeek lacks PDF input\. No plugin available yet/
    )
    expect(rec(scan(), 'deepseek:vision')!.text).toMatch(
      /^DeepSeek V4 Pro lacks image input \(DeepSeek Flash has it\)\. No plugin available yet/
    )
  })

  it('names an installed plugin only when it declares the gap, and never turns it on', () => {
    const list = vi.fn(() => [spotify, serper])
    const s = scan({ plugins: list })
    const r = rec(s, 'deepseek:web_search')!
    expect(r.text).toBe(
      'DeepSeek lacks web search. The Serper plugin can fill this gap with its web_search tool. Turn it on in Plugins to use it.'
    )
    expect(r.plugin).toEqual({ id: 'serper', name: 'Serper', tool: 'web_search', enabled: false })
    expect(serper.state).toBe('disabled')
    expect(list).toHaveBeenCalledTimes(1)
    // Spotify has a tool called search, but it doesn't declare web search.
    expect(rec(scan(), 'deepseek:web_search')!.plugin).toBeUndefined()
  })

  it('model features say no plugin can add them; nothing for what a provider has', () => {
    expect(rec(scan(), 'openai:fallbacks')!.text).toBe(
      'OpenAI lacks fallback on decline. No plugin can add this: it is part of the model.'
    )
    expect(rec(scan(), 'claude:web_search')).toBeUndefined()
    expect(rec(scan(), 'openai:vision')).toBeUndefined()
  })
})

describe('no provider calls', () => {
  it('scanning never touches the network', () => {
    const f = vi.spyOn(globalThis, 'fetch')
    scan()
    expect(f).not.toHaveBeenCalled()
    f.mockRestore()
  })
})

// Phase 5: the recommendation rules as docs/plugins/MANIFEST.md states them.
describe('recommendations, as documented for plugin authors', () => {
  const rec = (s: CapabilityScan, id: string): Recommendation | undefined =>
    s.recommendations.find((r) => `${r.provider}:${r.capability}` === id)
  const fillable = (s: CapabilityScan): Recommendation[] =>
    s.recommendations.filter((r) => ['web_search', 'pdf', 'vision'].includes(r.capability))

  it('with no plugins installed, every fillable gap says no plugin available yet', () => {
    const s = scan({ plugins: () => [] })
    expect(fillable(s).map((r) => r.text)).toEqual([
      'DeepSeek V4 Pro lacks image input (DeepSeek Flash has it). No plugin available yet. One could be built with a tool that describes an image.',
      'DeepSeek lacks PDF input. No plugin available yet. One could be built with a tool that turns a PDF into text.',
      'DeepSeek lacks web search. No plugin available yet. One could be built with a web search tool (a Serper or Brave Search plugin, say).'
    ])
    expect(s.recommendations.every((r) => r.plugin === undefined)).toBe(true)
    for (const r of s.recommendations.filter((r) => !fillable(s).includes(r)))
      expect(r.text).toMatch(/ No plugin can add this: it is part of the model\.$/)
  })

  it('turning the plugin on or off changes only the last sentence', () => {
    const on = plugin('serper', 'Serper', ['search'], 'enabled', [
      { capability: 'web_search', tool: 'search' }
    ])
    const off = { ...on, state: 'disabled' as const }
    const fresh = { ...on, state: 'not-activated' as const }
    const text = (p: PluginStatus): string =>
      rec(scan({ plugins: () => [p] }), 'deepseek:web_search')!.text
    const head =
      'DeepSeek lacks web search. The Serper plugin can fill this gap with its search tool.'
    expect(text(on)).toBe(`${head} It is on.`)
    expect(text(off)).toBe(`${head} Turn it on in Plugins to use it.`)
    expect(text(fresh)).toBe(`${head} Turn it on in Plugins to use it.`)
    expect(rec(scan({ plugins: () => [on] }), 'deepseek:web_search')!.plugin!.enabled).toBe(true)
  })

  it('one plugin can fill several gaps; only its declared ones', () => {
    const both = plugin('reader', 'Reader', ['pdf_text', 'describe_image'], 'enabled', [
      { capability: 'pdf', tool: 'pdf_text' },
      { capability: 'vision', tool: 'describe_image' }
    ])
    const s = scan({ plugins: () => [both] })
    expect(rec(s, 'deepseek:pdf')!.plugin?.tool).toBe('pdf_text')
    expect(rec(s, 'deepseek:vision')!.plugin?.tool).toBe('describe_image')
    expect(rec(s, 'deepseek:web_search')!.plugin).toBeUndefined()
  })

  it('several plugins for one gap: the first in the list (Plugins lists by id) is named', () => {
    const a = plugin('alpha-search', 'Alpha', ['find'], 'disabled', [
      { capability: 'web_search', tool: 'find' }
    ])
    const b = plugin('beta-search', 'Beta', ['find'], 'enabled', [
      { capability: 'web_search', tool: 'find' }
    ])
    expect(rec(scan({ plugins: () => [a, b] }), 'deepseek:web_search')!.plugin?.id).toBe(
      'alpha-search'
    )
  })

  it('never recommends a plugin for a gap no plugin can fill, even if its status claims one', () => {
    const odd = plugin('odd', 'Odd', ['think'], 'enabled', [
      { capability: 'reasoning' as 'pdf', tool: 'think' }
    ])
    const s = scan({ plugins: () => [odd] })
    expect(rec(s, 'deepseek:reasoning_summary')!.plugin).toBeUndefined()
    expect(s.recommendations.some((r) => r.plugin)).toBe(false)
  })
})
