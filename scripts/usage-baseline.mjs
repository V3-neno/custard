#!/usr/bin/env node
// Prompt-cache baseline from saved chats, for the token-efficiency phases in
// docs/ROADMAP.md. Reads each chat's `usage` totals and prints, per chat and
// overall, how much input was written to the cache versus read from it, and
// the cost per user message. Run it before and after a phase and compare.
//
//   node scripts/usage-baseline.mjs [conversations folder] [--min 10] [--json out.json]
//
// The folder defaults to Custard's own (%APPDATA%\custard\conversations on
// Windows). It only reads files; nothing is changed or sent anywhere.
//
// A chat whose cache works mostly reads: cache writes stay small next to
// cache reads. A write share near or above half on long chats means the
// prompt before the messages keeps changing and the history is billed again.
// Totals are per chat, so a chat used across both providers mixes them; the
// share is still a fair signal.

import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  if (i < 0) return fallback
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const min = Number(opt('--min', '10'))
const jsonOut = opt('--json', null)
const defaultDir =
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'custard', 'conversations')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'custard', 'conversations')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'custard', 'conversations')
const dir = args[0] ?? defaultDir

let files
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.json'))
} catch (err) {
  console.error(`Can't read ${dir}: ${err.message}`)
  process.exit(1)
}

// A user message the person typed: a string, or blocks other than tool results.
const typed = (m) =>
  m.role === 'user' &&
  (typeof m.content === 'string' || !m.content.some((b) => b.type === 'tool_result'))

const rows = []
for (const f of files) {
  let c
  try {
    c = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  } catch {
    continue
  }
  const u = c.usage
  if (!u || !Array.isArray(c.messages)) continue
  const turns = c.messages.filter(typed).length
  if (turns < min) continue
  const cached = (u.cacheWrite ?? 0) + (u.cacheRead ?? 0)
  rows.push({
    title: String(c.title ?? c.id).slice(0, 40),
    mode: c.mode ?? 'chat',
    turns,
    calls: u.calls ?? 0,
    input: u.input ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    cacheRead: u.cacheRead ?? 0,
    output: u.output ?? 0,
    cost: u.cost ?? 0,
    writeShare: cached ? (u.cacheWrite ?? 0) / cached : null,
    costPerTurn: turns ? (u.cost ?? 0) / turns : 0
  })
}

if (!rows.length) {
  console.log(`No chats with ${min} or more messages and saved usage in ${dir}.`)
  process.exit(0)
}

rows.sort((a, b) => b.cost - a.cost)
const k = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n)
const pct = (x) => (x === null ? '  -' : `${Math.round(x * 100)}%`.padStart(4))
console.log(`Chats with ${min}+ messages in ${dir}\n`)
console.log(
  [
    'Chat'.padEnd(40),
    'Msgs'.padStart(5),
    'Input'.padStart(7),
    'C.write'.padStart(8),
    'C.read'.padStart(8),
    'Write%'.padStart(6),
    'Output'.padStart(7),
    '$/msg'.padStart(7),
    'Cost'.padStart(8)
  ].join(' ')
)
for (const r of rows)
  console.log(
    [
      r.title.padEnd(40),
      String(r.turns).padStart(5),
      k(r.input).padStart(7),
      k(r.cacheWrite).padStart(8),
      k(r.cacheRead).padStart(8),
      pct(r.writeShare).padStart(6),
      k(r.output).padStart(7),
      `$${r.costPerTurn.toFixed(3)}`.padStart(7),
      `$${r.cost.toFixed(2)}`.padStart(8)
    ].join(' ')
  )

const sum = (key) => rows.reduce((n, r) => n + r[key], 0)
const total = {
  chats: rows.length,
  turns: sum('turns'),
  input: sum('input'),
  cacheWrite: sum('cacheWrite'),
  cacheRead: sum('cacheRead'),
  output: sum('output'),
  cost: sum('cost')
}
const share =
  total.cacheWrite + total.cacheRead
    ? total.cacheWrite / (total.cacheWrite + total.cacheRead)
    : null
console.log(
  `\nAll ${total.chats} chats: ${total.turns} messages, cache write share ${pct(share).trim()}, ` +
    `$${(total.cost / total.turns).toFixed(3)} per message, $${total.cost.toFixed(2)} in all.`
)
console.log('A healthy cache on long chats has a low write share (well under a third).')

if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      { at: new Date().toISOString(), dir, min, total, writeShare: share, rows },
      null,
      2
    )
  )
  console.log(`Saved to ${jsonOut}.`)
}
