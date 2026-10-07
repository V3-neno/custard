// Fake Claude API and Spotify for test/e2e/interrupt.mjs. Spotify's queue
// endpoint never answers, to stand for a write that was sent but whose
// result never came back.
import http from 'http'
import fs from 'fs'
const [, , OUT] = process.argv
const anth = []
const spotify = []
const save = () => {
  fs.writeFileSync(OUT + '/anthropic.json', JSON.stringify(anth, null, 1))
  fs.writeFileSync(OUT + '/spotify.json', JSON.stringify(spotify, null, 1))
}
const T1 = 'spotify:track:' + '1'.padStart(22, 'a')
const track = {
  uri: T1,
  name: 'Says',
  artists: [{ name: 'Nils Frahm' }],
  album: { name: 'Spaces', release_date: '2013-01-01' },
  explicit: false,
  duration_ms: 500000
}
const textOf = (m) =>
  typeof m.content === 'string'
    ? m.content
    : m.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
const isResults = (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')
let msg = 0
http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const j = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      if (url.pathname !== '/v1/messages') {
        spotify.push({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams)
        })
        save()
        if (url.pathname === '/api/token')
          return j(200, {
            access_token: 'AT',
            refresh_token: 'RT',
            expires_in: 3600,
            scope: 'user-read-playback-state user-read-currently-playing user-modify-playback-state'
          })
        if (url.pathname === '/v1/search') return j(200, { tracks: { items: [track] } })
        if (url.pathname === '/v1/me/player/devices')
          return j(200, {
            devices: [
              {
                id: 'desk1',
                name: 'Desktop',
                type: 'Computer',
                is_active: true,
                is_restricted: false
              }
            ]
          })
        if (url.pathname === '/v1/me/player/queue' && req.method === 'POST') return // never answers
        return j(404, { error: { status: 404, message: 'nope' } })
      }
      const b = JSON.parse(body)
      anth.push({ tools: (b.tools ?? []).map((t) => t.name), messages: b.messages })
      save()
      let last = b.messages.length - 1
      while (
        last >= 0 &&
        !(
          b.messages[last].role === 'user' &&
          !isResults(b.messages[last]) &&
          textOf(b.messages[last]).trim()
        )
      )
        last--
      const ask = textOf(b.messages[last])
      const step = b.messages.slice(last + 1).filter((m) => m.role === 'user').length
      const key = /stop test/.test(ask)
        ? 'stop'
        : /try again/.test(ask)
          ? 'again'
          : /error test/.test(ask)
            ? 'error'
            : /cut test/.test(ask)
              ? 'cut'
              : /Continue from where/.test(ask)
                ? 'rest'
                : /crash test/.test(ask)
                  ? 'crash'
                  : /mixed test/.test(ask)
                    ? 'mixed'
                    : /loop test/.test(ask)
                      ? 'loop'
                      : 'plain'
      if (key === 'error' && step === 1)
        return j(400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Something in the request was wrong.' }
        })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, data) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      send('message_start', {
        message: {
          id: 'msg_' + ++msg,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 }
        }
      })
      let idx = 0
      const text = (t) => {
        send('content_block_start', { index: idx, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: idx, delta: { type: 'text_delta', text: t } })
        send('content_block_stop', { index: idx++ })
      }
      const tool = (name, input) => {
        send('content_block_start', {
          index: idx,
          content_block: { type: 'tool_use', id: `toolu_${msg}_${idx}`, name, input: {} }
        })
        send('content_block_delta', {
          index: idx,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
        })
        send('content_block_stop', { index: idx++ })
      }
      const scripts = {
        stop: [
          () => tool('vault_append', { path: 'Log.md', content: 'before' }),
          () => tool('spotify__search', { query: 'Nils Frahm Says' }),
          () => {
            tool('spotify__add_to_queue', { uris: [T1] })
            tool('vault_append', { path: 'Log.md', content: 'after' })
          }
        ],
        again: [() => tool('spotify__add_to_queue', { uris: [T1] }), 'I did not queue it again.'],
        error: [() => tool('vault_read', { path: 'Areas/Music Preferences.md' })],
        cut: ['This is a long answer that'],
        rest: ['and here is the rest.'],
        crash: [
          () => tool('spotify__search', { query: 'Nils Frahm Says' }),
          () => tool('spotify__add_to_queue', { uris: [T1] })
        ],
        // One write that works and one read that fails, then a cut-off reply.
        mixed: [
          () => {
            tool('vault_append', { path: 'Log.md', content: 'mixed' })
            tool('vault_read', { path: 'Missing.md' })
          },
          'Logged it, and the other note'
        ],
        // Never gives a final answer, to reach the step limit.
        loop: [() => tool('vault_read', { path: 'Log.md' })],
        plain: ['OK.']
      }
      const s = scripts[key][Math.min(step, scripts[key].length - 1)]
      let stop = 'tool_use'
      if (typeof s === 'function') s()
      else {
        text(s)
        stop = key === 'cut' || key === 'mixed' ? 'max_tokens' : 'end_turn'
      }
      send('message_delta', {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 30 }
      })
      send('message_stop', {})
      res.end()
    })
  })
  .listen(8899)
