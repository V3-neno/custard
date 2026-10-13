// Hub workspaces step 2 (the Plugins hub chat): scripts for
// test/e2e/plugins-hub.mjs.
const ASKS = [
  [/hub open test/, 'h_open'],
  [/hub create test/, 'h_create'],
  [/hub write test/, 'h_write']
]
export const trigger = (ask) => ASKS.find(([r]) => r.test(ask))?.[1]

export const scripts = ({ tool }) => ({
  h_open: [
    () =>
      tool('workspace_propose', {
        action: 'open',
        plugin: 'spotify',
        request: 'Add a shuffle tool to Spotify.'
      }),
    'Pick Yes to open it.'
  ],
  h_create: [
    () =>
      tool('workspace_propose', {
        action: 'create',
        name: 'Weather Now',
        request: 'Build a weather plugin that shows today.'
      }),
    'Pick Yes to create it.'
  ],
  // A hub chat trying to change things anyway.
  h_write: [
    () => tool('vault_create_note', { path: 'hub-made.md', content: 'x' }),
    () => tool('fs_write', { path: 'x.txt', content: 'x' }),
    'Tried.'
  ]
})
