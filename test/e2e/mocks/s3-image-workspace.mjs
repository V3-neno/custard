// Stabilization thread 3: a fake OpenAI Image API and scripted design_media
// calls for test/e2e/design-image-workspace.mjs. The app reaches it through
// OPENAI_BASE_URL=http://127.0.0.1:8899/s3/v1, so it never answers
// workstream B's /v1 requests. Generations return an amber 64×48 PNG and
// edits a blue one, so the test can tell versions apart by the pixels the
// workspace actually draws. A prompt with "s3fail" gets a 500. Each request
// is logged to <out>/s3-images.json without the key.
import fs from 'fs'
import zlib from 'zlib'

export const AMBER = [200, 120, 40]
export const BLUE = [40, 90, 200]

// A solid-colour RGB PNG.
export function solidPng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export function route({ req, url, body, j, OUT }) {
  if (url.pathname !== '/s3/v1/images/generations' && url.pathname !== '/s3/v1/images/edits')
    return false
  const edit = url.pathname.endsWith('/edits')
  const prompt = edit
    ? (/name="prompt"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? '')
    : String(JSON.parse(body || '{}').prompt ?? '')
  // Appended to the file (not kept in memory), so a test that deletes the
  // file starts from an empty log even while this mock keeps running.
  const file = OUT + '/s3-images.json'
  let log = []
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    log = []
  }
  log.push({
    path: url.pathname,
    prompt,
    files: edit ? [...body.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]) : [],
    keyOk: req.headers.authorization === 'Bearer sk-openai-test'
  })
  fs.writeFileSync(file, JSON.stringify(log, null, 1))
  if (/s3fail/.test(prompt))
    return (j(500, { error: { message: 'The server had an error.' } }), true)
  j(200, {
    created: 1,
    output_format: 'png',
    data: [{ b64_json: solidPng(64, 48, edit ? BLUE : AMBER).toString('base64') }]
  })
  return true
}

export const trigger = (ask) =>
  [
    [/s3 gen test/, 's3_gen'],
    [/s3 edit test/, 's3_edit'],
    [/s3 fail test/, 's3_fail'],
    [/s3 long video test/, 's3_long_video']
  ].find(([r]) => r.test(ask))?.[1]

// The id of the output the last design_media result named.
const lastOutput = (b) => {
  for (let i = b.messages.length - 1; i >= 0; i--)
    for (const c of Array.isArray(b.messages[i].content) ? b.messages[i].content : [])
      if (c.type === 'tool_result') {
        const m = /Output ([A-Za-z0-9_-]+), version/.exec(
          typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
        )
        if (m) return m[1]
      }
  return undefined
}

export function scripts({ tool, b }) {
  return {
    s3_gen: [
      () =>
        tool('design_media', {
          operation: 'image.generate',
          prompt: 'a brass lantern on a workbench',
          name: 'Lantern'
        }),
      'Made it.'
    ],
    s3_edit: [
      () =>
        tool('design_media', {
          operation: 'image.edit',
          prompt: 'make the lantern blue',
          references: ['lantern-ref.png'],
          artifact: lastOutput(b),
          relation: 'revision'
        }),
      'Edited.'
    ],
    // The same input both times, so the second is a repeat of an unknown one.
    s3_fail: [
      () =>
        tool('design_media', {
          operation: 'image.edit',
          prompt: 's3fail make the lantern green',
          references: ['lantern-ref.png'],
          artifact: lastOutput(b),
          relation: 'revision'
        }),
      'Sent.'
    ],
    // A plugin video that stays in progress (the slowmo fixture without "fast").
    s3_long_video: [
      () =>
        tool('design_media', {
          operation: 'video.text-to-video',
          prompt: 'a slow pan across a forge at dusk',
          name: 'Dusk pan',
          durationSeconds: 2
        }),
      'Submitted.'
    ]
  }
}
