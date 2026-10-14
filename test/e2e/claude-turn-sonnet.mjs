// The Claude chat turn's characterization test (claude-turn.mjs, which runs
// its own stand-in with http.createServer) on claude-sonnet-5-5, against
// test/e2e/claude-turn-claude-sonnet-5-5.golden.json.
// Usage, from the repo root after `npx electron-vite build`:
//   node test/e2e/claude-turn-sonnet.mjs <out> <screenshot dir> [--update]
process.env.CLAUDE_TURN_MODEL = 'claude-sonnet-5-5'
await import('./claude-turn.mjs')
