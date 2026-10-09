// Workstream D: sandbox escape probes for test/e2e/design-security.mjs.
// Every request that reaches /d-leak is recorded: a preview must never get
// there.
import fs from 'fs'

const leaks = []
export function route({ url, req, OUT, j }) {
  if (!url.pathname.startsWith('/d-leak')) return false
  leaks.push({ method: req.method, path: url.pathname, query: url.search })
  fs.writeFileSync(OUT + '/d-leak.json', JSON.stringify(leaks, null, 1))
  j(200, { ok: true })
  return true
}

const ASKS = [
  [/d escape test/, 'd_escape'],
  [/d plain test/, 'd_plain'],
  [/d ref test/, 'd_ref'],
  [/d page test/, 'd_page']
]
export const trigger = (ask) => ASKS.find(([r]) => r.test(ask))?.[1]

const LEAK = 'http://127.0.0.1:8899/d-leak'
const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`

// What the checklist in docs/design/SANDBOX.md adds beyond A's probe: other
// schemes and Custard's own, path tricks, workers and frames, frames talking
// to the app, external app links (plugins' and Obsidian's), print,
// fullscreen, clipboard, and storage shared between the check run and the
// visible preview. Results come back as console.error lines starting "D ".
const ESCAPE = page(
  'Escape',
  `<h1>Escape probe</h1>
<div id="out"></div>
<iframe id="dataframe" src="data:text/html,<script>fetch('${LEAK}?via=dataframe').then(()=>console.error('D LEAKED dataframe'),()=>{})</script>"></iframe>
<iframe id="srcdoc" srcdoc="<script>try{parent.parent.postMessage('D-FROM-FRAME','*')}catch(e){}</script>"></iframe>
<a id="ob" href="obsidian://new?vault=Custard&file=Custard%2FSkills%2Fevil%2FSKILL&content=x">o</a>
<style>@import url('${LEAK}?via=cssimport'); @font-face { font-family: x; src: url('${LEAK}?via=font'); } h1 { font-family: x }</style>
<script>
window.__d = {}
const report = (k, v) => {
  window.__d[typeof v === 'string' ? v : k] = k
  console.error('D ' + k + ' ' + JSON.stringify(v))
}
const prior = localStorage.getItem('d-mark')
const priorCookie = document.cookie
localStorage.setItem('d-mark', String(Date.now()))
document.cookie = 'dmark=1; path=/'
document.body.dataset.prior = prior ? 'seen' : 'none'
document.body.dataset.priorCookie = priorCookie ? 'seen' : 'none'
window.__d.frames = { top: window.top === window, parent: window.parent === window, opener: window.opener }
const tryFetch = (via, url) =>
  fetch(url).then(
    (r) => report(r.ok ? 'LEAKED' : 'BLOCKED', via),
    () => report('BLOCKED', via)
  )
tryFetch('lan', 'https://192.168.0.1/')
tryFetch('loopback-https', 'https://127.0.0.1:8899/d-leak')
tryFetch('file', 'file:///etc/passwd')
tryFetch('media-scheme', 'custard-media://x/y')
tryFetch('dotdot', '/%2e%2e/%2e%2e/artifacts.json')
tryFetch('dotdot2', '/..%2f..%2fartifacts.json')
tryFetch('backslash', '/..%5c..%5cartifacts.json')
try { const es = new EventSource('${LEAK}?via=eventsource'); es.onopen = () => report('LEAKED', 'eventsource'); es.onerror = () => report('BLOCKED', 'eventsource') } catch (e) { report('BLOCKED', 'eventsource') }
import('${LEAK}?via=import').then(() => report('LEAKED', 'import'), () => report('BLOCKED', 'import'))
try {
  const wk = new Worker(URL.createObjectURL(new Blob(["fetch('${LEAK}?via=worker').then(()=>postMessage('L'),()=>postMessage('B'))"])))
  wk.onmessage = (e) => report(e.data === 'L' ? 'LEAKED' : 'BLOCKED', 'worker')
  wk.onerror = () => report('BLOCKED', 'worker')
} catch (e) { report('BLOCKED', 'worker') }
try { navigator.clipboard.writeText('D-CLIP').then(() => report('LEAKED', 'clipboard'), () => report('BLOCKED', 'clipboard')) } catch (e) { report('BLOCKED', 'clipboard') }
try { document.documentElement.requestFullscreen().then(() => report('LEAKED', 'fullscreen'), () => report('BLOCKED', 'fullscreen')) } catch (e) { report('BLOCKED', 'fullscreen') }
window.postMessage('D-SELF', '*')
// The visible preview: the test reads window.__d, then calls window.__dRisky()
// for the attempts that would end the page if they worked, and last
// window.__dPrint().
window.__dPrint = () => {
  try { window.print() } catch (e) {}
}
window.__dRisky = () => {
  try { document.getElementById('ob').click() } catch (e) {}
  setTimeout(() => { try { location.href = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' } catch (e) {} }, 50)
  setTimeout(() => { try { location.href = 'data:text/html,<h1>D-NAVIGATED</h1>' } catch (e) {} }, 100)
  setTimeout(() => { try { location.href = '${LEAK}?via=location' } catch (e) {} }, 150)
  return 'started'
}
</script>`
)

export const scripts = ({ tool }) => ({
  d_escape: [() => tool('design_html', { name: 'Escape', html: ESCAPE }), 'Made the escape probe.'],
  // design-attachments.mjs: an edit that names one of two attached images.
  d_ref: [
    () =>
      tool('design_media', {
        operation: 'image.edit',
        prompt: 'make it amber',
        references: ['Osprey-8890.png'],
        name: 'Edited'
      }),
    'Edited.'
  ],
  d_page: [
    () =>
      tool('design_html', {
        name: 'Page',
        html: page('Page', '<p>A page made beside the attachments.</p>')
      }),
    'Made a page.'
  ],
  d_plain: [
    () => tool('design_html', { name: 'Plain', html: page('Plain', '<p>Plain page</p>') }),
    'Made a plain page.'
  ]
})
