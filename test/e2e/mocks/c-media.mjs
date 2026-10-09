// Workstream C mock scripts: Design asks the slowmo fixture plugin for video
// (test/e2e/design-media.mjs). The plugin's result link is answered here.
import fs from 'fs'

const CLIP = new URL('../../fixtures/media-plugins/slowmo/src/clip.ts', import.meta.url)

// The result link (https://media.example.com/clip.webm, through the test
// transport) gets the fixture clip.
export function route({ req, res, url }) {
  if (url.pathname !== '/c-media/clip.webm') return false
  const b64 = fs.readFileSync(CLIP, 'utf8').match(/'([A-Za-z0-9+/=]{1000,})'/)[1]
  const body = Buffer.from(b64, 'base64')
  res.writeHead(req.headers['x-c-expired'] ? 410 : 200, { 'content-type': 'video/webm' })
  res.end(body)
  return true
}

export const trigger = (ask) =>
  [
    [/c video test/, 'c_video'],
    [/c link test/, 'c_link'],
    [/c direct test/, 'c_direct'],
    [/c reject test/, 'c_reject'],
    [/c cancel test/, 'c_cancel']
  ].find(([r]) => r.test(ask))?.[1]

// The job id from the last design_media or design_jobs result.
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

export function scripts({ tool, b }) {
  const media = (prompt) => () =>
    tool('design_media', {
      operation: 'video.text-to-video',
      prompt,
      name: 'Forge pan',
      durationSeconds: 2
    })
  const check = () => tool('design_jobs', { action: 'check', job: lastJob(b) })
  return {
    c_video: [media('a slow pan across a forge, fast'), check, 'The video is ready.'],
    c_link: [media('the same pan as a link, url fast'), check, 'Done.'],
    c_reject: [media('please reject this one'), 'It was refused.'],
    c_cancel: [
      media('a long one to cancel'),
      () => tool('design_jobs', { action: 'cancel', job: lastJob(b) }),
      'Cancelled.'
    ],
    // The plugin's submit tool called directly, as a plain tool.
    c_direct: [
      () =>
        tool('slowmo__submit', {
          operation: 'video.text-to-video',
          prompt: 'direct',
          idempotencyKey: 'direct-1'
        }),
      'Tried it directly.'
    ]
  }
}
