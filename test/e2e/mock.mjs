// Mock Anthropic Messages API (SSE) and Spotify, for the end-to-end run.
import http from 'http'
import fs from 'fs'
const [, , OUT, PLUGIN_DIR] = process.argv
const anth = [],
  spotify = [],
  chatNotes = []
const save = () => {
  fs.writeFileSync(OUT + '/anthropic.json', JSON.stringify(anth, null, 1))
  fs.writeFileSync(OUT + '/spotify.json', JSON.stringify(spotify, null, 1))
}
const id = (n) => String(n).padStart(22, 'a')
const songs = [
  'Says|Nils Frahm',
  'Awake|Tycho',
  'Near Light|Ólafur Arnalds',
  'Dive|Tycho',
  'Ambre|Nils Frahm'
]
const track = (n) => {
  const [name, artist] = songs[n - 1].split('|')
  return {
    uri: `spotify:track:${id(n)}`,
    name,
    artists: [{ name: artist }],
    album: { name: 'Album', release_date: '2016-01-01' },
    explicit: false,
    duration_ms: 300000
  }
}
const queue = []
let msg = 0
const textOf = (m) =>
  typeof m.content === 'string'
    ? m.content
    : m.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const j = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(data === undefined ? '' : JSON.stringify(data))
      }
      // The key check on Save: Claude's model list, so the key counts as
      // working and the chat's model can be used.
      if (url.pathname === '/v1/models')
        return j(200, {
          data: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'].map((id) => ({
            type: 'model',
            id,
            display_name: id,
            created_at: '2026-01-01T00:00:00Z'
          })),
          has_more: false,
          first_id: 'claude-opus-5-5',
          last_id: 'claude-haiku-4-5'
        })
      if (url.pathname !== '/v1/messages') {
        spotify.push({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          auth: req.headers.authorization,
          body
        })
        save()
        if (url.pathname === '/api/token')
          return j(200, {
            access_token: 'AT-secret-123',
            refresh_token: 'RT-secret-456',
            expires_in: 3600,
            scope: 'user-read-playback-state user-read-currently-playing user-modify-playback-state'
          })
        if (req.headers.authorization !== 'Bearer AT-secret-123')
          return j(401, { error: { status: 401, message: 'no token' } })
        if (url.pathname === '/v1/search') {
          const q = url.searchParams.get('q')
          const n =
            songs.findIndex((s) => q.toLowerCase().includes(s.split('|')[0].toLowerCase())) + 1
          return j(200, { tracks: { items: n ? [track(n)] : [] } })
        }
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
        if (url.pathname === '/v1/me/player/queue' && req.method === 'POST') {
          queue.push(url.searchParams.get('uri'))
          res.writeHead(204)
          return res.end()
        }
        if (url.pathname === '/v1/me/player/queue')
          return j(200, { currently_playing: null, queue: queue.map((u) => ({ uri: u })) })
        return j(404, { error: { status: 404, message: 'nope' } })
      }
      const b = JSON.parse(body)
      // A chat's summary note in Custard/Chats: no tools, JSON out. Recorded
      // on its own so the chat's request list stays as the other tests expect.
      if (typeof b.system === 'string' && b.system.startsWith('You summarize a chat for a note')) {
        const evidence = String(b.messages[0].content)
        chatNotes.push({ model: b.model, tools: b.tools ?? null, evidence })
        fs.writeFileSync(OUT + '/chatnotes.json', JSON.stringify(chatNotes, null, 1))
        if (/note fail test/.test(evidence))
          return j(500, { type: 'error', error: { type: 'api_error', message: 'Internal error' } })
        const n = chatNotes.length
        return j(200, {
          id: 'msg_chatnote',
          type: 'message',
          role: 'assistant',
          model: b.model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                goal: 'Plan a calm evening playlist',
                constraints: ['Ask before queueing anything'],
                decisions: ['Keep it instrumental'],
                // A link and markup the note must not keep.
                open: ['Check [this](https://evil.example/x) **soon**'],
                state: `Summary number ${n}: the playlist is half done.`
              })
            }
          ]
        })
      }
      anth.push({
        tools: (b.tools ?? []).map((t) => t.name),
        system: typeof b.system === 'string' ? b.system : JSON.stringify(b.system),
        messages: b.messages
      })
      save()
      // The newest plain user message decides the script; the step is how many tool rounds followed it.
      let last = b.messages.length - 1
      while (
        last >= 0 &&
        !(
          b.messages[last].role === 'user' &&
          textOf(b.messages[last]).trim() &&
          !(
            Array.isArray(b.messages[last].content) &&
            b.messages[last].content.some((c) => c.type === 'tool_result')
          ) &&
          // Results of calls to tools no longer offered are sent as text
          // (see main/history); they are not something the user asked.
          !textOf(b.messages[last]).startsWith('[Result of that earlier call')
        )
      )
        last--
      const ask = textOf(b.messages[last])
      const step = b.messages.slice(last + 1).filter((m) => m.role === 'user').length
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
          content_block: { type: 'tool_use', id: 'toolu_' + msg + '_' + idx, name, input: {} }
        })
        send('content_block_delta', {
          index: idx,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
        })
        send('content_block_stop', { index: idx++ })
      }
      const scripts = {
        bump: [
          () => tool('fs_read', { path: 'plugin.json' }),
          () => {
            const m = fs
              .readFileSync(PLUGIN_DIR + '/spotify/plugin.json', 'utf8')
              .replace('"version": "1.0.0"', '"version": "1.0.1"')
            tool('fs_write', { path: 'plugin.json', content: m })
          },
          () => {
            tool('fs_read', { path: '../../src/main/index.ts' })
            tool('fs_read', { path: '/etc/passwd' })
            tool('fs_write', { path: '../escape.txt', content: 'x' })
          },
          () => {
            tool('plugin_validate', {})
            tool('plugin_test', {})
          },
          null,
          'Version 1.0.1 is validated and its tests pass. It is not active yet: review it in Settings → Plugins.'
        ],
        queue: [
          () => tool('vault_read', { path: 'Areas/Music Preferences.md' }),
          () => songs.forEach((s) => tool('spotify__search', { query: s.replace('|', ' ') })),
          () =>
            tool('spotify__add_to_queue', {
              uris: [1, 2, 3, 4, 5].map((n) => `spotify:track:${id(n)}`)
            }),
          null,
          'I queued five focus tracks on your Desktop: Says, Awake, Near Light, Dive and Ambre.'
        ],
        recommend: [
          null,
          'You might like Hammock, Helios and Kiasmos. I have not queued anything.'
        ],
        stale: [
          () => tool('spotify__add_to_queue', { uris: [`spotify:track:${id(1)}`] }),
          null,
          'Spotify is not available right now, so nothing was queued.'
        ]
      }
      const key = /bump/i.test(ask)
        ? 'bump'
        : /recommend/i.test(ask)
          ? 'recommend'
          : /one more/i.test(ask)
            ? 'stale'
            : 'queue'
      const s = scripts[key]
      const end = s.indexOf(null)
      let stop = 'tool_use'
      if (step < end) s[step]()
      else {
        text(s[end + 1])
        stop = 'end_turn'
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
