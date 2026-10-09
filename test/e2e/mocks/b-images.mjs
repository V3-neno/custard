// Workstream B: a fake OpenAI Image API for test/e2e/design-images.mjs, and
// the model's scripted design_media calls. The app reaches it through
// OPENAI_BASE_URL=http://127.0.0.1:8899/v1 (development builds only; a
// packaged build pins api.openai.com). Each request is logged to
// <out>/b-images.json without the key.
import fs from 'fs'
import zlib from 'zlib'

const log = []
const save = (OUT) => fs.writeFileSync(OUT + '/b-images.json', JSON.stringify(log, null, 1))

// A real 3×2 PNG, so the app window can load and measure it.
export function png(w = 3, h = 2) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
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
    for (let x = 0; x < w; x++) raw.set([200, 120, 40], y * (w * 3 + 1) + 1 + x * 3)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export function route({ req, res, url, body, j, OUT }) {
  if (url.pathname !== '/v1/images/generations' && url.pathname !== '/v1/images/edits') return false
  const edit = url.pathname.endsWith('/edits')
  let fields = {}
  if (edit) {
    // Multipart; only the text fields and file names are recorded.
    for (const m of body.matchAll(
      /name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: ([^\r]+)\r\n)?\r\n([^\r]*)/g
    ))
      if (m[2] !== undefined) (fields.files ??= []).push({ field: m[1], name: m[2], type: m[3] })
      else fields[m[1]] = m[4]
  } else fields = JSON.parse(body || '{}')
  const prompt = String(fields.prompt ?? '')
  log.push({
    path: url.pathname,
    model: fields.model,
    prompt,
    n: Number(fields.n),
    output_format: fields.output_format,
    size: fields.size,
    files: fields.files,
    multipart: /^multipart\/form-data/.test(req.headers['content-type'] ?? ''),
    keyOk: req.headers.authorization === 'Bearer sk-openai-test',
    retry: req.headers['x-stainless-retry-count'] ?? null
  })
  save(OUT)
  if (/b500/.test(prompt)) return (j(500, { error: { message: 'The server had an error.' } }), true)
  if (/b400/.test(prompt))
    return (
      j(400, {
        error: {
          message: 'Your request was rejected by the safety system.',
          type: 'invalid_request_error',
          code: 'moderation_blocked'
        }
      }),
      true
    )
  j(200, {
    created: 1,
    output_format: 'png',
    size: '1024x1024',
    data: [{ b64_json: png().toString('base64') }]
  })
  return true
}

export function trigger(ask) {
  return [
    [/b gen test/, 'b_gen'],
    [/b edit test/, 'b_edit'],
    [/b variation test/, 'b_var'],
    [/b fail test/, 'b_500'],
    [/b refuse test/, 'b_400']
  ].find(([r]) => r.test(ask))?.[1]
}

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
  const media = (input) => () => tool('design_media', input)
  return {
    b_gen: [
      media({ operation: 'image.generate', prompt: 'a copper kettle on a stove', name: 'Kettle' }),
      'Made it.'
    ],
    b_edit: [
      () =>
        tool('design_media', {
          operation: 'image.edit',
          prompt: 'make the kettle blue',
          references: ['kettle.png'],
          artifact: lastOutput(b),
          relation: 'revision'
        }),
      'Edited.'
    ],
    b_var: [
      media({ operation: 'image.variation', prompt: 'another one', references: ['kettle.png'] }),
      'Tried.'
    ],
    b_500: [media({ operation: 'image.generate', prompt: 'b500 a teapot' }), 'Sent.'],
    b_400: [media({ operation: 'image.generate', prompt: 'b400 a teapot' }), 'Sent.']
  }
}
