// Workstream A: Design workspace scripts for test/e2e/design-workspace.mjs.
// Every request that reaches /a-leak is recorded: a preview must never get
// there.
import fs from 'fs'

const leaks = []
export function route({ url, req, OUT, j }) {
  if (!url.pathname.startsWith('/a-leak')) return false
  leaks.push({ method: req.method, path: url.pathname, query: url.search })
  fs.writeFileSync(OUT + '/a-leak.json', JSON.stringify(leaks, null, 1))
  j(200, { ok: true })
  return true
}

const ASKS = [
  [/a html test/, 'a_html'],
  [/a revise test/, 'a_revise'],
  [/a variation test/, 'a_variation'],
  [/a fragment test/, 'a_fragment'],
  [/a reference test/, 'a_reference'],
  [/a skills test/, 'a_skills'],
  [/a conflict test/, 'a_conflict'],
  [/a probe test/, 'a_probe'],
  [/a loop test/, 'a_loop'],
  [/a second test/, 'a_second']
]
export const trigger = (ask) => ASKS.find(([r]) => r.test(ask))?.[1]

const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`

const LEAK = 'http://127.0.0.1:8899/a-leak'
// Tries every way out it can, and reports what it could see as an error
// line (errors are what the preview reports back).
const PROBE = page(
  'Probe',
  `<h1 id="h">Probe</h1>
<img src="${LEAK}?via=img"><img src="https://example.com/a.png"><img src="file:///etc/passwd">
<link rel="stylesheet" href="${LEAK}?via=link">
<iframe src="${LEAK}?via=iframe"></iframe><iframe src="http://localhost:8899/a-leak?via=localhost"></iframe>
<form id="f" action="${LEAK}?via=form" method="post"><input name="x" value="1"></form>
<script>
const seen = {
  custard: typeof window.custard, require: typeof require, process: typeof process,
  ipc: typeof window.ipcRenderer, electron: typeof window.electron, opener: window.opener === null,
  origin: location.origin
}
console.error('PROBE ' + JSON.stringify(seen))
fetch('${LEAK}?via=fetch').then(() => console.error('LEAKED fetch'), () => {})
const x = new XMLHttpRequest(); x.open('GET', '${LEAK}?via=xhr'); x.onload = () => console.error('LEAKED xhr'); x.send()
try { const ws = new WebSocket('ws://127.0.0.1:8899/a-leak?via=ws'); ws.onopen = () => console.error('LEAKED ws') } catch {}
navigator.sendBeacon && navigator.sendBeacon('${LEAK}?via=beacon', 'x')
const w = window.open('${LEAK}?via=open'); if (w) console.error('LEAKED open')
try { document.getElementById('f').submit() } catch {}
setTimeout(() => { location.href = '${LEAK}?via=location' }, 50)
alert('alert from the page')
</script>`
)

const lastId = (b, re) => {
  for (let i = b.messages.length - 1; i >= 0; i--)
    for (const c of Array.isArray(b.messages[i].content) ? b.messages[i].content : [])
      if (c.type === 'tool_result') {
        const m = re.exec(
          String(Array.isArray(c.content) ? c.content.map((x) => x.text).join('') : c.content)
        )
        if (m) return m[1]
      }
  return null
}
const outputId = (b) => lastId(b, /output ([0-9a-f-]{36})/)
// The first version of the newest output.
const firstVersion = (b) => lastId(b, /version 1 \(([0-9a-f-]{36})\)/)

export const scripts = ({ tool, b }) => ({
  a_html: [
    () =>
      tool('design_html', {
        name: 'Landing',
        html: page(
          'Landing',
          '<main class="hero"><h1>Forge</h1><p>Version one.</p></main>',
          '<link rel="stylesheet" href="css/site.css">'
        ),
        files: [
          {
            path: 'css/site.css',
            content:
              'body{margin:0;font-family:sans-serif;background:#1e160f;color:#ffe2a3}.hero{padding:48px}'
          }
        ]
      }),
    'Made the landing page.'
  ],
  a_revise: [
    () =>
      tool('design_html', {
        artifact: outputId(b),
        html: page(
          'Landing',
          '<main class="hero"><h1>Forge</h1><p>Version two, revised.</p></main>',
          '<link rel="stylesheet" href="css/site.css">'
        )
      }),
    'Revised it.'
  ],
  a_variation: [
    () =>
      tool('design_html', {
        artifact: outputId(b),
        from: firstVersion(b),
        relation: 'variation',
        html: page('Landing', '<main><h1>Forge</h1><p>Another option.</p></main>')
      }),
    'Here is another option.'
  ],
  a_fragment: [
    () => tool('design_html', { artifact: outputId(b), html: '<div>just a fragment</div>' }),
    'That one was refused.'
  ],
  a_reference: [
    () =>
      tool('design_html', {
        artifact: outputId(b),
        html: page('Landing', '<img src="assets/logo.png" alt="logo"><p>With your logo.</p>'),
        references: [{ attachment: 'logo.png', path: 'assets/logo.png' }]
      }),
    'Used your logo.'
  ],
  a_skills: [
    () =>
      tool('design_html', {
        artifact: outputId(b),
        html: page('Landing', '<p>Branded.</p>'),
        skills: [
          {
            path: 'Custard/Skills/brand-guide/SKILL.md',
            strength: 'explicit',
            guidance: 'Amber on near-black; rounded pills.'
          },
          { path: 'Custard/Skills/print-layout/SKILL.md', strength: 'similar', material: false }
        ]
      }),
    'Applied the brand guide.'
  ],
  a_conflict: [
    () =>
      tool('design_html', {
        artifact: outputId(b),
        html: page('Landing', '<p>Should not be saved.</p>'),
        skills: [
          {
            path: 'Custard/Skills/brand-guide/SKILL.md',
            strength: 'clear',
            conflicts: ['Custard/Skills/print-layout/SKILL.md']
          },
          { path: 'Custard/Skills/print-layout/SKILL.md', strength: 'clear' }
        ]
      }),
    'Which should I follow?'
  ],
  a_probe: [() => tool('design_html', { name: 'Probe', html: PROBE }), 'Made the probe.'],
  a_loop: [
    () =>
      tool('design_html', {
        name: 'Loop',
        html: page('Loop', '<p>never</p><script>for(;;){}</script>')
      }),
    'Made the loop.'
  ],
  a_second: [
    () => tool('design_html', { name: 'Card', html: page('Card', '<div>Second output</div>') }),
    'Made a second output.'
  ]
})
