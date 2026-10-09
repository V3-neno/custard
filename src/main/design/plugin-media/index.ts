import { pluginHost } from '../../plugins'
import { registerProviders } from '../registry'
import { pluginMediaProviders, type PluginMediaDeps } from './adapter'
import type { BinaryTransport } from './results'

// Workstream C: media providers from enabled plugins' `media` declarations,
// registered with registerProviders('plugins', ...). Called once at startup;
// the list is read again on every use, so enabling, disabling, updating or
// removing a plugin shows at once.

// Design's approval card is the approval for a plugin submission: one card,
// asked every time, and the plugin's own card is skipped for that one submit
// call only (Neno's decision, 2026-10-09; see docs/design/MEDIA-PLUGINS.md).
export const SUBMIT_APPROVAL: ReturnType<PluginMediaDeps['submitApproval']> = 'design-card'

export function registerPluginMedia(): void {
  const host = pluginHost
  registerProviders('plugins', () =>
    pluginMediaProviders({
      catalog: () => host().mediaCatalog(),
      invoke: (a, o) => host().invokeMedia(a, o),
      hosts: (id) => host().mediaHosts(id),
      submitApproval: () => SUBMIT_APPROVAL,
      // Test hook for the end-to-end run against a local mock. Only code
      // already running in the main process can set it.
      transport: () =>
        (globalThis as { __custardMediaTransport?: BinaryTransport }).__custardMediaTransport
    })
  )
}
