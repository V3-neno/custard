// Script tools (test/e2e/scripts.mjs): the model calls the sample scraper
// script's tools.
const ASKS = [
  [/s look test/, 's_look'],
  [/s save test/, 's_save'],
  [/s slow test/, 's_slow']
]
export const trigger = (ask) => ASKS.find(([r]) => r.test(ask))?.[1]

export const scripts = ({ tool }) => ({
  s_look: [() => tool('script_scraper__look', { url: 'https://example.com/a' }), 'Looked.'],
  s_save: [() => tool('script_scraper__save', { url: 'https://example.com/a' }), 'Asked.'],
  s_slow: [() => tool('script_scraper__slow', {}), 'Stopped.']
})
