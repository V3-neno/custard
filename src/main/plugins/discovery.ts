import { readFileSync } from 'fs'
import { capabilities, type Capability } from '../../shared/adapter'
import type { CapabilityScan, Recommendation } from '../../shared/capabilityScan'
import { providerNames, type Provider } from '../../shared/providers'
import { GAP, list } from '../adapters/scan'
import { resolveInVault } from '../memory/paths'

// Settings → Capabilities → Start building: a starter prompt for a plugin
// that works around a gap, from the plugin-discovery skill. The skill is a
// note with one section per capability; Custard fills in its placeholders
// itself (no model is asked), from the vault's copy when it has a usable
// section, otherwise from the copy bundled with Custard. The prompt only
// goes in the new workspace's message box, for the user to check and send.

export const DISCOVERY_SKILL = 'Custard/Skills/plugin-discovery/SKILL.md'
const MAX_SKILL = 100_000
const MAX_PROMPT = 4_000
const MAX_NAME = 60

export type StarterTemplate = { name: string; prompt: string }

// `## <capability>` sections, each opening with `Plugin name: …`. Anything
// else in the note is for people reading it.
export function parseDiscoverySkill(text: string): Map<string, StarterTemplate> {
  const out = new Map<string, StarterTemplate>()
  const body = text.slice(0, MAX_SKILL).replace(/\r\n/g, '\n')
  const parts = body.split(/^## +/m).slice(1)
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const id = (nl < 0 ? part : part.slice(0, nl)).trim()
    if (!/^[a-z_]+$/.test(id)) continue
    const rest = (nl < 0 ? '' : part.slice(nl + 1)).trim()
    const m = /^Plugin name:[ \t]*(.+)\n+([\s\S]+)$/.exec(rest)
    if (!m) continue
    const name = m[1].trim().slice(0, MAX_NAME)
    const prompt = m[2].trim()
    if (!name || !prompt || prompt.length > MAX_PROMPT) continue
    out.set(id, { name, prompt })
  }
  return out
}

const fill = (template: string, r: Recommendation): string =>
  template
    .replace(/\{who\}/g, r.who)
    .replace(/\{has\}/g, r.having.length ? ` (${list(r.having)} can)` : '')
    .replace(/\{provider\}/g, providerNames[r.provider])
    .replace(/\{gap\}/g, GAP[r.capability])

// The template for a capability: the vault's section, then the bundled one,
// then each copy's `default`.
export function starterTemplate(
  capability: Capability,
  vaultText: string | null,
  bundledText: string
): { template: StarterTemplate; from: 'vault' | 'bundled' } {
  const vault = vaultText ? parseDiscoverySkill(vaultText) : new Map<string, StarterTemplate>()
  const bundled = parseDiscoverySkill(bundledText)
  const own = vault.get(capability)
  if (own) return { template: own, from: 'vault' }
  const built = bundled.get(capability)
  if (built) return { template: built, from: 'bundled' }
  const def = vault.get('default')
  if (def) return { template: def, from: 'vault' }
  const fallback = bundled.get('default')
  if (!fallback) throw new Error('The plugin-discovery skill bundled with Custard has no prompts.')
  return { template: fallback, from: 'bundled' }
}

// The gap to build for, checked against a fresh scan: it must be a gap the
// provider has now, with no installed plugin declaring it.
export function gapFor(
  scan: CapabilityScan,
  provider: unknown,
  capability: unknown
): Recommendation {
  if (!(capabilities as readonly unknown[]).includes(capability))
    throw new Error('That is not a capability Custard knows.')
  const r = scan.recommendations.find((x) => x.provider === provider && x.capability === capability)
  if (!r)
    throw new Error(`${providerNames[provider as Provider] ?? 'That provider'} doesn't lack this.`)
  if (r.plugin)
    throw new Error(
      `The ${r.plugin.name} plugin already fills this. Turn it on in Plugins to use it.`
    )
  return r
}

export type StarterPrompt = { name: string; request: string; from: 'vault' | 'bundled' }

export function starterPrompt(
  r: Recommendation,
  vault: string | null,
  bundledText: string
): StarterPrompt {
  let vaultText: string | null = null
  if (vault)
    try {
      vaultText = readFileSync(resolveInVault(vault, DISCOVERY_SKILL), 'utf8')
    } catch {
      // No skill in the vault (or unreadable): the bundled copy.
    }
  const { template, from } = starterTemplate(r.capability, vaultText, bundledText)
  return { name: template.name, request: fill(template.prompt, r), from }
}
