// Step 6 (earlier chats as reference): scripts for test/e2e/earlier-chats.mjs.
const ASKS = [
  [/e search test/, 'e_search'],
  [/e read test/, 'e_read']
]
export const trigger = (ask) => ASKS.find(([r]) => r.test(ask))?.[1]

const systemText = (b) =>
  typeof b.system === 'string' ? b.system : (b.system ?? []).map((s) => s.text).join('\n')

export const scripts = ({ tool, b }) => ({
  e_search: [() => tool('chats_search', { query: 'evening playlist' }), 'Found it.'],
  // The first earlier chat listed in the prompt, by the first 8 characters
  // of its id.
  e_read: [
    () =>
      tool('chats_read', {
        chat: /; chat ([0-9a-f-]{8})/.exec(systemText(b))?.[1] ?? 'missing!'
      }),
    'Read it.'
  ]
})
