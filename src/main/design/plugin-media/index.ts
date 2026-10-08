import { pluginHost } from '../../plugins'
import { registerProviders } from '../registry'
import { pluginMediaProviders, type PluginMediaDeps } from './adapter'
import type { BinaryTransport } from './results'

// Workstream C: media providers from enabled plugins' `media` declarations,
// registered with registerProviders('plugins', ...). Called once at startup;
// the list is read again on every use, so enabling, disabling, updating or
// removing a plugin shows at once.

// Whether Design's approval card is the approval for a plugin submission
// (see docs/design/MEDIA-PLUGINS.md). 'pending' until Neno decides; nothing
// is submitted to a plugin while it is.
export const SUBMIT_APPROVAL: ReturnType<PluginMediaDeps['submitApproval']> = 'pending'

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
