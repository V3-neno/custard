import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { capabilities, type Capability } from '../../shared/adapter'
import type { Recommendation } from '../../shared/capabilityScan'
import type { PluginStatus } from '../../shared/plugins'
import { scanCapabilities } from '../adapters/scan'
import {
  DISCOVERY_SKILL,
  gapFor,
  parseDiscoverySkill,
  starterPrompt,
  starterTemplate
} from './discovery'

// Start building: the starter prompt for a gap, from the plugin-discovery
// skill, filled in without a model.

const BUNDLED = readFileSync(join('vault-template', DISCOVERY_SKILL), 'utf8')
const vault = mkdtempSync(join(tmpdir(), 'custard-discovery-'))
afterAll(() => rmSync(vault, { recursive: true, force: true }))

const scan = (plugins: PluginStatus[] = []): ReturnType<typeof scanCapabilities> =>
  scanCapabilities({ vault: null, plugins: () => plugins, checks: () => null })
const gap = (provider: string, capability: string): Recommendation =>
  gapFor(scan(), provider, capability)
const prompt = (provider: string, capability: string, v: string | null = null): string =>
  starterPrompt(gap(provider, capability), v, BUNDLED).request

describe('the bundled skill', () => {
  const sections = parseDiscoverySkill(BUNDLED)

  it('has a section for every gap a provider has today, and a default', () => {
    const gaps = new Set(scan().recommendations.map((r) => r.capability))
    for (const c of gaps) expect(sections.has(c), c).toBe(true)
    expect(sections.has('default')).toBe(true)
  })

  it('every section names a plugin and fills in with no placeholder left', () => {
    for (const [id, t] of sections) {
      expect(t.name.length, id).toBeGreaterThan(1)
      const filled = starterTemplate(
        (capabilities as readonly string[]).includes(id) ? (id as Capability) : 'text',
        null,
        BUNDLED
      )
      expect(filled.template.prompt).not.toMatch(/\{(?!who|has|provider|gap)\w+\}/)
    }
    for (const r of scan().recommendations)
      expect(starterPrompt(r, null, BUNDLED).request, r.capability).not.toMatch(/\{\w+\}/)
  })

  it('points every prompt at the plugin docs and says what fills allows', () => {
    for (const r of scan().recommendations) {
      const p = starterPrompt(r, null, BUNDLED).request
      expect(p, r.capability).toMatch(/docs\/MANIFEST\.md/)
      expect(p, r.capability).toMatch(
        ['web_search', 'pdf', 'vision'].includes(r.capability)
          ? /declare `fills/i
          : /can't go in `fills`/
      )
    }
  })
})

describe('starter prompts', () => {
  it('web search for DeepSeek', () => {
    const p = prompt('deepseek', 'web_search')
    expect(p).toMatch(/^DeepSeek can't search the web in Custard\. Let's build a plugin/)
    expect(p).toMatch(/Serper, Brave Search or DuckDuckGo/)
    expect(p).toMatch(/"capability": "web_search"/)
    expect(starterPrompt(gap('deepseek', 'web_search'), null, BUNDLED).name).toBe('Web Search')
  })

  it('images for DeepSeek V4 Pro only, saying Flash can', () => {
    expect(prompt('deepseek', 'vision')).toMatch(
      /^DeepSeek V4 Pro can't see images in Custard \(DeepSeek Flash can\)\./
    )
  })

  it('effort for Haiku 4.5: a different prompt that says no plugin can add it to the model', () => {
    const p = prompt('claude', 'effort')
    expect(p).toMatch(
      /^Haiku 4\.5 doesn't take effort levels in Custard \(Opus 5\.5 and Sonnet 5\.5 can\)/
    )
    expect(p).toMatch(/no plugin can add them to the model itself/)
    expect(p).not.toBe(prompt('deepseek', 'web_search'))
  })

  it('thinking (reasoning) for Haiku 4.5', () => {
    expect(prompt('claude', 'reasoning')).toMatch(/no plugin can add that to the model itself/)
  })

  it('the vault copy wins, so the user can reword it', () => {
    mkdirSync(join(vault, 'Custard/Skills/plugin-discovery'), { recursive: true })
    writeFileSync(
      join(vault, DISCOVERY_SKILL),
      '# Mine\n\n## web_search\nPlugin name: Finder\n\nMake {who} search ({provider}, {gap}){has}.\n\n## pdf\nbroken: no name line\n'
    )
    const r = starterPrompt(gap('deepseek', 'web_search'), vault, BUNDLED)
    expect(r).toEqual({
      name: 'Finder',
      request: 'Make DeepSeek search (DeepSeek, web search).',
      from: 'vault'
    })
    // A broken section falls back to the bundled one.
    const pdf = starterPrompt(gap('deepseek', 'pdf'), vault, BUNDLED)
    expect(pdf.from).toBe('bundled')
    expect(pdf.name).toBe('PDF Reader')
  })

  it('no vault, or no skill in it: the bundled copy', () => {
    expect(starterPrompt(gap('deepseek', 'pdf'), null, BUNDLED).from).toBe('bundled')
    expect(starterPrompt(gap('deepseek', 'pdf'), join(vault, 'nope'), BUNDLED).from).toBe('bundled')
  })

  it('a capability with no section uses default', () => {
    const t = starterTemplate('streaming', null, BUNDLED)
    expect(t.template.name).toBe('Capability Helper')
  })

  it('is plain text work: no network', () => {
    const f = vi.spyOn(globalThis, 'fetch')
    prompt('deepseek', 'web_search')
    expect(f).not.toHaveBeenCalled()
    f.mockRestore()
  })
})

describe('which gaps can be built for', () => {
  it('every gap, fillable or not', () => {
    for (const r of scan().recommendations)
      expect(() => gapFor(scan(), r.provider, r.capability)).not.toThrow()
  })

  it('not a capability a provider has, a gap a plugin fills, or an unknown capability', () => {
    expect(() => gapFor(scan(), 'claude', 'web_search')).toThrow("Claude doesn't lack this.")
    const serper = {
      id: 'serper',
      name: 'Serper',
      state: 'disabled',
      tools: [{ name: 'search', fullName: 'serper__search', effect: 'read', askEveryTime: false }],
      fills: [{ capability: 'web_search', tool: 'search' }]
    } as PluginStatus
    expect(() => gapFor(scan([serper]), 'deepseek', 'web_search')).toThrow(
      'The Serper plugin already fills this. Turn it on in Plugins to use it.'
    )
    expect(() => gapFor(scan(), 'deepseek', 'thinking')).toThrow('not a capability Custard knows')
    expect(() => gapFor(scan(), 'nobody', 'pdf')).toThrow("doesn't lack this")
  })
})
