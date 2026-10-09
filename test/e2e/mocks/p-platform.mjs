// Thread 4 (stabilization 4.3): preview pages for test/e2e/preview-platform.mjs.
// Results are left on window.__p for the harness to read.
const ASKS = [
  [/p plain test/, 'p_plain'],
  [/p webrtc test/, 'p_webrtc'],
  [/p keys test/, 'p_keys'],
  [/p oom test/, 'p_oom'],
  [/p media test/, 'p_media']
]
export const trigger = (ask) => ASKS.find(([r]) => r.test(ask))?.[1]

import os from 'os'

// A non-loopback address of this machine, standing in for a LAN host.
const LAN =
  Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '10.255.255.1'
export const lanAddress = LAN

const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`

// ICE gathering against a STUN/TURN "server" on 127.0.0.1:3478 (the harness
// listens there for UDP and TCP), plus whatever host candidates leak.
const WEBRTC = page(
  'WebRTC',
  `<p>webrtc</p><script>
window.__p = { state: 'started', candidates: [] }
try {
  const pc = new RTCPeerConnection({ iceServers: [
    { urls: 'stun:127.0.0.1:3478' },
    { urls: ['turn:127.0.0.1:3478?transport=udp', 'turn:127.0.0.1:3478?transport=tcp', 'turn:${LAN}:3478?transport=tcp'], username: 'u', credential: 'p' }
  ] })
  pc.createDataChannel('x')
  pc.onicecandidate = (e) => {
    if (e.candidate) window.__p.candidates.push(e.candidate.candidate)
    else window.__p.state = 'complete'
  }
  pc.onicecandidateerror = (e) => { window.__p.errors = (window.__p.errors || 0) + 1 }
  pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => (window.__p.state = 'offer failed ' + e))
  setTimeout(() => { if (window.__p.state === 'started') window.__p.state = 'timeout' }, 8000)
} catch (e) {
  window.__p.state = 'refused ' + e
}
</script>`
)

const KEYS = page(
  'Keys',
  `<h1>Keyboard</h1><button id="a">First</button><a href="#x" id="b">Link</a><input id="c" aria-label="Field"><button id="d">Last</button>
<script>
window.__p = { keys: [], focus: [] }
addEventListener('keydown', (e) => window.__p.keys.push(e.key), true)
addEventListener('focusin', (e) => window.__p.focus.push(e.target.id || e.target.tagName))
</script>`
)

// Grows the JS heap until the renderer dies (V8's own heap limit).
const OOM = page(
  'Oom',
  `<p>oom</p><script>
const keep = []
const grow = () => { for (let i = 0; i < 64; i++) keep.push(new Array(1 << 20).fill(i + Math.random())); setTimeout(grow, 0) }
setTimeout(grow, 1500)
</script>`
)

// test/e2e/media-sizes.mjs: "p media test <words>" asks the bigmedia fixture
// for a file; the words after "test" are its prompt (see its src/index.ts).
const askOf = (b) => {
  const text = (m) =>
    typeof m.content === 'string'
      ? m.content
      : m.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('')
  for (const m of [...b.messages].reverse()) {
    const hit = m.role === 'user' && /p media test (.*)/.exec(text(m))
    if (hit) return hit[1].trim()
  }
  return ''
}
const lastJob = (b) => {
  const texts = b.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result')
    .map((c) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)))
  for (const t of texts.reverse()) {
    const id = /Job ([0-9a-f-]{36})/.exec(t)?.[1]
    if (id) return id
  }
  return 'none'
}

export const scripts = ({ tool, b }) => ({
  p_media: [
    () => {
      const prompt = askOf(b)
      const video = /webm=/.test(prompt)
      return tool('design_media', {
        operation: video ? 'video.text-to-video' : 'image.generate',
        prompt,
        name: video ? 'Big clip' : 'Big image',
        ...(video ? { durationSeconds: 2 } : {})
      })
    },
    () => tool('design_jobs', { action: 'check', job: lastJob(b) }),
    'Checked.'
  ],
  p_plain: [
    () => tool('design_html', { name: 'Plain', html: page('Plain', '<p>Plain page</p>') }),
    'Made a plain page.'
  ],
  p_webrtc: [() => tool('design_html', { name: 'WebRTC', html: WEBRTC }), 'Made the WebRTC probe.'],
  p_keys: [() => tool('design_html', { name: 'Keys', html: KEYS }), 'Made the keyboard page.'],
  p_oom: [() => tool('design_html', { name: 'Oom', html: OOM }), 'Made the memory page.']
})
