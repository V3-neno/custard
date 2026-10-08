// Small, structurally valid files for tests: only the parts Custard reads.

export function png(width = 10, height = 20): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

export function jpeg(width = 30, height = 40): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    // APP0, 16 bytes
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.alloc(14),
    // SOF0
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255]),
    Buffer.alloc(12),
    Buffer.from([0xff, 0xd9])
  ])
}

export function gif(frames = 1, width = 5, height = 6): Buffer {
  const head = Buffer.alloc(13)
  head.write('GIF89a', 0, 'latin1')
  head.writeUInt16LE(width, 6)
  head.writeUInt16LE(height, 8)
  head[10] = 0 // no global colour table
  const parts = [head]
  for (let i = 0; i < frames; i++) {
    // Graphic control extension, then an image with one data sub-block.
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0x00]))
    const desc = Buffer.alloc(10)
    desc[0] = 0x2c
    desc.writeUInt16LE(width, 5)
    desc.writeUInt16LE(height, 7)
    parts.push(desc, Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

export function webp(width = 7, height = 9, animated = 0): Buffer {
  const chunks: Buffer[] = []
  const vp8x = Buffer.alloc(18)
  vp8x.write('VP8X', 0, 'latin1')
  vp8x.writeUInt32LE(10, 4)
  vp8x[8] = animated ? 0x02 : 0
  vp8x.writeUIntLE(width - 1, 12, 3)
  vp8x.writeUIntLE(height - 1, 15, 3)
  chunks.push(vp8x)
  for (let i = 0; i < animated; i++) {
    const c = Buffer.alloc(8 + 16)
    c.write('ANMF', 0, 'latin1')
    c.writeUInt32LE(16, 4)
    chunks.push(c)
  }
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length + 4, 4)
  head.write('WEBP', 8, 'latin1')
  return Buffer.concat([head, body])
}

export function pdf(pages = 2, extra = ''): Buffer {
  const objs = Array.from(
    { length: pages },
    (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`
  )
  return Buffer.from(
    `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${objs.join('\n')}\n${extra}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    'latin1'
  )
}
