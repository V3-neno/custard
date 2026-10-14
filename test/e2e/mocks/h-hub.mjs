// Hub workspaces steps 2 and 4 (the Plugins and Skills hub chats, and a
// skill's workspace): scripts for test/e2e/plugins-hub.mjs and
// test/e2e/skills-hub.mjs.
const ASKS = [
  [/skill open test/, 'h_skill_open'],
  [/skill create test/, 'h_skill_create'],
  [/skill write test/, 'h_skill_write'],
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
  h_skill_open: [
    () =>
      tool('workspace_propose', {
        action: 'open',
        skill: 'weekly-review',
        request: 'Add a section for next week.'
      }),
    'Pick Yes to open it.'
  ],
  h_skill_create: [
    () =>
      tool('workspace_propose', {
        action: 'create',
        name: 'Standup notes',
        request: 'Write a skill for my daily standup notes.'
      }),
    'Pick Yes to create it.'
  ],
  // In a skill's workspace: one note inside its folder, one outside.
  h_skill_write: [
    () =>
      tool('vault_create_note', {
        path: 'Custard/Skills/meeting-notes/template.md',
        content: '# Meeting\n'
      }),
    () => tool('vault_create_note', { path: 'outside-skill.md', content: 'x' }),
    'Done.'
  ],
  // A hub chat trying to change things anyway.
  h_write: [
    () => tool('vault_create_note', { path: 'hub-made.md', content: 'x' }),
    () => tool('fs_write', { path: 'x.txt', content: 'x' }),
    'Tried.'
  ]
})
