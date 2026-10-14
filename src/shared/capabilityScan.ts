import type { Capability, Evidence } from './adapter'
import type { Provider } from './providers'

// Settings → Capabilities: what Custard can use (its own tools, plugins,
// skills, features) and what each provider can do, from Custard's own rules.
// Built on the user's computer from local files only: no provider is asked.

// Capabilities a plugin can add to a model that lacks them, by offering a
// tool: search results, the text of a PDF, a description of an image. The
// rest are part of how the model itself runs.
export const fillableCapabilities = ['web_search', 'pdf', 'vision'] as const
export type FillableCapability = (typeof fillableCapabilities)[number]

export const isFillable = (c: Capability): c is FillableCapability =>
  (fillableCapabilities as readonly string[]).includes(c)

export type InventoryCategory = 'vault' | 'chats' | 'web' | 'plugin' | 'skill' | 'feature'

// One thing a chat can use.
//   provider: who supplies it ("Custard", a plugin's name, "Your vault").
//   tool: the tool name a model calls, or null for a skill or feature.
//   needs: capabilities a model must have for it to work.
//   uses: the tools a skill names in its SKILL.md.
export type InventoryItem = {
  id: string
  name: string
  category: InventoryCategory
  provider: string
  tool: string | null
  needs: Capability[]
  uses?: string[]
  // Plugins: whether it is on now. Never changed by the scan.
  state?: 'enabled' | 'disabled' | 'not-activated'
}

// supported / not supported come from Custard's rules; unknown is a model
// Custard has no rules for (one a provider lists that Custard doesn't
// support yet).
export type CellState = 'supported' | 'unsupported' | 'unknown'

export type MatrixCell = {
  state: CellState
  evidence: Evidence
  // "DeepSeek Flash only", the reason from the rule, or which model was
  // tested live.
  note?: string
}

export type MatrixColumn = {
  id: string
  label: string
  provider: Provider
  kind: 'provider' | 'model' | 'discovered'
  cells: Record<Capability, MatrixCell>
}

export type Recommendation = {
  capability: Capability
  // Who lacks it: a provider, or the models of one that lack it.
  provider: Provider
  models: string[]
  // How the sentence names them ("DeepSeek", "DeepSeek V4 Pro"), and the
  // provider's models that have it.
  who: string
  having: string[]
  text: string
  // Custard's own tools and features that need it.
  affects: string[]
  // An installed plugin that offers a tool for it. Recommended only: the
  // scan never turns a plugin on.
  plugin?: { id: string; name: string; tool: string; enabled: boolean }
}

export type CapabilityScan = {
  scannedAt: number
  inventory: InventoryItem[]
  providers: MatrixColumn[]
  models: MatrixColumn[]
  recommendations: Recommendation[]
}
