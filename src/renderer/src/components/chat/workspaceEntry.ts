// Settings → Capabilities → Start building: the new plugin whose workspace
// Plugins mode opens next, with the starter prompt in its message box (not
// sent). App queues it and remounts Plugins mode; ChatView reads it as it
// mounts and clears it once shown.

export type PluginEntry = { pluginId: string; request: string }

let pending: PluginEntry | null = null

export const queuePluginWorkspace = (e: PluginEntry): void => {
  pending = e
}
export const peekPluginWorkspace = (): PluginEntry | null => pending
export const clearPluginWorkspace = (e: PluginEntry): void => {
  if (pending === e) pending = null
}
