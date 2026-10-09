// Test-only TLS front for running the mock e2e suite against a *packaged*
// build. Packaged builds pin the provider endpoints to api.anthropic.com and
// api.openai.com and ignore ANTHROPIC_BASE_URL / OPENAI_BASE_URL (L13), and
// that protection stays on. Instead the test machine maps both hosts to
// 127.0.0.1 (hosts file), trusts a throwaway CA through NODE_EXTRA_CA_CERTS,
// and this server forwards every request to the mock on 127.0.0.1:8899.
// Nothing here is part of the app.
//   node test/platform/tls-front.mjs <dir with front.key and front.crt> [port=443] [host=port ...]
// A host=port pair sends that host somewhere else (design-security.mjs's
// restart check holds OpenAI requests on 8898: api.openai.com=8898).
// See test/platform/README.md for the full setup (scripts/packaged-linux.sh).
import https from 'https'
import http from 'http'
import fs from 'fs'

const [, , DIR, PORT = '443', ...ROUTES] = process.argv
const routes = new Map(ROUTES.map((r) => [r.split('=')[0], Number(r.split('=')[1])]))
const server = https.createServer(
  { key: fs.readFileSync(`${DIR}/front.key`), cert: fs.readFileSync(`${DIR}/front.crt`) },
  (req, res) => {
    const up = http.request(
      {
        host: '127.0.0.1',
        port: routes.get(String(req.headers.host ?? '').split(':')[0]) ?? 8899,
        path: req.url,
        method: req.method,
        headers: req.headers
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      }
    )
    up.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(up)
  }
)
server.listen(Number(PORT), '127.0.0.1', () => console.log(`tls-front on ${PORT}`))
