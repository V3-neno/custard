import { readFileSync } from 'fs'
import { capabilities, type Capability, type ModelCheck } from '../../shared/adapter'
import type {
  CapabilityScan,
  InventoryItem,
  MatrixCell,
  MatrixColumn,
  Recommendation
} from '../../shared/capabilityScan'
import { isFillable } from '../../shared/capabilityScan'
import { chatModels } from '../../shared/chat'
import type { PluginStatus } from '../../shared/plugins'
import { providerIds, providerNames, type Provider } from '../../shared/providers'
import { chatTools } from '../earlierChats'
import { resolveInVault } from '../memory/paths'
import { listSkills, vaultChangeTools, vaultTools } from '../vault'
import { webReadTool } from '../web/read'
import { webSearchTool } from '../web/search'
import { capabilitiesOf } from './capabilities'

// Settings → Capabilities. Everything here is read from Custard's own rules
// and files on this computer: the matrix from capabilitiesOf (the same rules
// that refuse a PDF, drop web search or turn on thinking), the inventory from
// the vault, the installed plugins and Custard's tool lists. Nothing here
// calls a provider or a model; a model's own claim about itself (Phase 4b)
// would sit beside this, never replace it.

export type ScanSources = {
  vault: string | null
  plugins: () => PluginStatus[]
  // The last Save/Refresh key check per provider, as stored. Only read.
  checks: (p: Provider) => ModelCheck | null
  now?: () => number
}

const CUSTARD = 'Custard'

// Built-in features that depend on a capability, so a gap says what it costs.
const FEATURES: { id: string; name: string; needs: Capability[] }[] = [
  { id: 'continue', name: 'Continue in a new chat (handoff)', needs: ['json_schema'] },
  { id: 'chat-notes', name: 'Chat notes', needs: ['json_schema'] },
  { id: 'memory-capture', name: 'Automatic memory capture', needs: ['json_schema'] },
  { id: 'image-attachments', name: 'Image attachments', needs: ['vision'] },
  { id: 'pdf-attachments', name: 'PDF attachments', needs: ['pdf'] },
  { id: 'long-chats', name: 'Long chats without starting over', needs: ['compaction'] },
  { id: 'thinking', name: 'Visible thinking', needs: ['reasoning_summary'] },
  { id: 'effort', name: 'Effort picker', needs: ['effort'] },
  { id: 'context-gauge', name: 'Exact context gauge', needs: ['token_counting'] },
  { id: 'fallback', name: 'Retry on another model when declined', needs: ['fallbacks'] }
]

// A skill can only name tools; this is how much of SKILL.md is searched.
const SKILL_TEXT = 200_000

export function scanInventory(src: ScanSources): InventoryItem[] {
  const tool = (
    name: string,
    category: InventoryItem['category'],
    needs: Capability[] = []
  ): InventoryItem => ({
    id: `${category}:${name}`,
    name,
    category,
    provider: CUSTARD,
    tool: name,
    needs: ['tool_use', ...needs]
  })
  const items: InventoryItem[] = []
  if (src.vault) {
    for (const t of [...vaultTools, ...vaultChangeTools]) items.push(tool(t.name, 'vault'))
    for (const t of chatTools) items.push(tool(t.name, 'chats'))
  }
  items.push(tool(webSearchTool.name, 'web', ['web_search']), tool(webReadTool.name, 'web'))

  for (const p of safeList(src.plugins))
    for (const t of p.tools)
      items.push({
        id: `plugin:${t.fullName}`,
        name: t.name,
        category: 'plugin',
        provider: p.name,
        tool: t.fullName,
        needs: ['tool_use'],
        state: p.state
      })

  if (src.vault) {
    const vault = src.vault
    const byTool = new Map(items.filter((i) => i.tool).map((i) => [i.tool!, i]))
    for (const s of listSkills(vault)) {
      let text = ''
      try {
        text = readFileSync(resolveInVault(vault, s.path), 'utf8').slice(0, SKILL_TEXT)
      } catch {
        // Unreadable now: listed without the tools it uses.
      }
      const uses = [...byTool.keys()].filter((name) =>
        new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`).test(text)
      )
      items.push({
        id: `skill:${s.folder}`,
        name: s.name,
        category: 'skill',
        provider: 'Your vault',
        tool: null,
        needs: [...new Set(uses.flatMap((u) => byTool.get(u)!.needs))],
        uses
      })
    }
  }

  for (const f of FEATURES)
    items.push({
      id: `feature:${f.id}`,
      name: f.name,
      category: 'feature',
      provider: CUSTARD,
      tool: null,
      needs: f.needs
    })
  return items
}

// A plugin list that fails to load gives no plugins rather than no scan.
function safeList(list: () => PluginStatus[]): PluginStatus[] {
  try {
    return list()
  } catch {
    return []
  }
}

const cellsOf = (id: string): Record<Capability, MatrixCell> => {
  const caps = capabilitiesOf(id)
  return Object.fromEntries(
    capabilities.map((c) => [
      c,
      {
        state: caps[c].supported ? 'supported' : 'unsupported',
        evidence: caps[c].evidence,
        ...(caps[c].note ? { note: caps[c].note } : {})
      }
    ])
  ) as Record<Capability, MatrixCell>
}

const unknownCells = (): Record<Capability, MatrixCell> =>
  Object.fromEntries(
    capabilities.map((c) => [
      c,
      { state: 'unknown', evidence: 'docs', note: 'Custard has no rules for this model yet.' }
    ])
  ) as Record<Capability, MatrixCell>

// One column per model Custard offers, then (from the last key check) each
// model a provider lists that Custard doesn't support yet, as unknown.
export function modelColumns(checks: ScanSources['checks']): MatrixColumn[] {
  const known: MatrixColumn[] = chatModels().map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    kind: 'model',
    cells: cellsOf(m.id)
  }))
  const discovered: MatrixColumn[] = providerIds.flatMap((p) => {
    let check: ModelCheck | null = null
    try {
      check = checks(p)
    } catch {
      // No stored check to read.
    }
    return (check?.models ?? [])
      .filter((m) => m.source === 'discovered')
      .map((m) => ({
        id: m.id,
        label: m.label,
        provider: p,
        kind: 'discovered' as const,
        cells: unknownCells()
      }))
  })
  return [...known, ...discovered]
}

export const list = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

// A provider's column, from its models' columns. Supported when any of its
// models has it (saying which, when not all do). Tagged live only when every
// model that has it was seen working live; otherwise docs, with the live
// model named in the note.
export function providerColumn(provider: Provider, models: MatrixColumn[]): MatrixColumn {
  const mine = models.filter((m) => m.provider === provider && m.kind === 'model')
  const cells = Object.fromEntries(
    capabilities.map((c): [Capability, MatrixCell] => {
      const yes = mine.filter((m) => m.cells[c].state === 'supported')
      if (!yes.length) {
        const note = mine.find((m) => m.cells[c].note)?.cells[c].note
        return [c, { state: 'unsupported', evidence: 'docs', ...(note ? { note } : {}) }]
      }
      const live = yes.filter((m) => m.cells[c].evidence === 'live')
      const notes: string[] = []
      if (yes.length < mine.length) notes.push(`${list(yes.map((m) => m.label))} only.`)
      const shared = yes[0].cells[c].note
      if (shared && yes.every((m) => m.cells[c].note === shared)) notes.push(shared)
      if (live.length && live.length < yes.length)
        notes.push(`Seen working live on ${list(live.map((m) => m.label))}; the rest from docs.`)
      return [
        c,
        {
          state: 'supported',
          evidence: live.length === yes.length ? 'live' : 'docs',
          ...(notes.length ? { note: notes.join(' ') } : {})
        }
      ]
    })
  ) as Record<Capability, MatrixCell>
  return { id: provider, label: providerNames[provider], provider, kind: 'provider', cells }
}

// A capability as a sentence says it: "DeepSeek lacks PDF input."
export const GAP: Record<Capability, string> = {
  text: 'text chat',
  streaming: 'streamed replies',
  tool_use: 'tools',
  json_schema: 'structured output',
  vision: 'image input',
  pdf: 'PDF input',
  reasoning: 'thinking',
  reasoning_summary: 'visible thinking',
  effort: 'effort levels',
  web_search: 'web search',
  prompt_caching: 'prompt caching',
  compaction: 'compaction of long chats',
  token_counting: 'exact token counts',
  fallbacks: 'fallback on decline'
}

// What a plugin tool could be built for, when none is installed.
const BUILD_HINT: Record<'web_search' | 'pdf' | 'vision', string> = {
  web_search: 'a web search tool (a Serper or Brave Search plugin, say)',
  pdf: 'a tool that turns a PDF into text',
  vision: 'a tool that describes an image'
}

// For each capability some of a provider's models lack: the installed plugin
// that offers a tool for it, if there is one, or that none is available.
// Recommends only; it never enables, installs or changes a plugin.
export function recommend(
  models: MatrixColumn[],
  inventory: InventoryItem[],
  plugins: PluginStatus[]
): Recommendation[] {
  const out: Recommendation[] = []
  for (const provider of providerIds) {
    const mine = models.filter((m) => m.provider === provider && m.kind === 'model')
    for (const c of capabilities) {
      const lacking = mine.filter((m) => m.cells[c].state === 'unsupported')
      if (!lacking.length) continue
      const having = mine.filter((m) => m.cells[c].state === 'supported')
      const who =
        lacking.length === mine.length ? providerNames[provider] : list(lacking.map((m) => m.label))
      const verb = lacking.length === 1 || lacking.length === mine.length ? 'lacks' : 'lack'
      const head =
        `${who} ${verb} ${GAP[c]}` +
        (having.length
          ? ` (${list(having.map((m) => m.label))} ${having.length === 1 ? 'has' : 'have'} it).`
          : '.')
      const affects = inventory
        .filter((i) => i.needs.includes(c) && i.category !== 'skill')
        .map((i) => i.name)
      const base = {
        capability: c,
        provider,
        models: lacking.map((m) => m.id),
        who,
        having: having.map((m) => m.label),
        affects
      }
      if (!isFillable(c)) {
        out.push({ ...base, text: `${head} No plugin can add this: it is part of the model.` })
        continue
      }
      const filler = plugins
        .flatMap((p) => (p.fills ?? []).map((f) => ({ p, f })))
        .find(({ f }) => f.capability === c)
      if (!filler) {
        out.push({
          ...base,
          text: `${head} No plugin available yet. One could be built with ${BUILD_HINT[c]}.`
        })
        continue
      }
      const enabled = filler.p.state === 'enabled'
      out.push({
        ...base,
        text:
          `${head} The ${filler.p.name} plugin can fill this gap with its ${filler.f.tool} tool.` +
          (enabled ? ' It is on.' : ' Turn it on in Plugins to use it.'),
        plugin: { id: filler.p.id, name: filler.p.name, tool: filler.f.tool, enabled }
      })
    }
  }
  return out
}

export function scanCapabilities(src: ScanSources): CapabilityScan {
  const plugins = safeList(src.plugins)
  const inventory = scanInventory({ ...src, plugins: () => plugins })
  const models = modelColumns(src.checks)
  return {
    scannedAt: (src.now ?? Date.now)(),
    inventory,
    providers: providerIds.map((p) => providerColumn(p, models)),
    models,
    recommendations: recommend(models, inventory, plugins)
  }
}
