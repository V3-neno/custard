import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

// Turns a fetched response into text a model can read: the readable part of
// an HTML page with its title and links, or text, Markdown and JSON as they
// are. Everything here is untrusted content.

export type Extracted = {
  kind: 'html' | 'text' | 'markdown' | 'json'
  title: string
  text: string
  links: { text: string; url: string }[]
  // How many more distinct links the page had than `links` lists.
  moreLinks?: number
  // Set only with evidence: a <noscript> notice or an empty app root.
  needsScript: boolean
}

export class ExtractError extends Error {}

const MAX_LINKS = 50

export function mimeOf(contentType: string | undefined): { mime: string; charset: string } {
  const [mime, ...params] = (contentType ?? '').split(';').map((s) => s.trim())
  const charset = params.map((p) => /^charset=["']?([^"']+)/i.exec(p)?.[1]).find(Boolean)
  return { mime: (mime || '').toLowerCase(), charset: charset ?? 'utf-8' }
}

function decode(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

const squash = (s: string): string => s.replace(/[ \t\f\v\r\u00a0]+/g, ' ').trim()

// Block-level text with Markdown-ish headings and list items. Links become
// "text [n]" with n pointing into the link list.
function toText(
  root: Element,
  base: string,
  links: Extracted['links'],
  dropped: Set<string>
): string {
  const out: string[] = []
  let line = ''
  const flush = (): void => {
    const t = squash(line)
    if (t) out.push(t)
    line = ''
  }
  const index = new Map<string, number>()
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      line += node.textContent ?? ''
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    if (/^(script|style|noscript|template|svg|iframe|button|form|input|select)$/.test(tag)) return
    const block =
      /^(p|div|section|article|header|footer|main|aside|h[1-6]|li|ul|ol|pre|blockquote|table|tr|br|hr|figure|figcaption|dl|dt|dd)$/.test(
        tag
      )
    if (block) flush()
    if (/^h[1-6]$/.test(tag)) line += `${'#'.repeat(Number(tag[1]))} `
    if (tag === 'li') line += '- '
    if (tag === 'pre') {
      out.push('```\n' + (el.textContent ?? '').replace(/\n+$/, '') + '\n```')
      return
    }
    for (const child of Array.from(el.childNodes)) walk(child)
    if (tag === 'a') {
      const href = el.getAttribute('href')
      let url: string | null = null
      try {
        url = href ? new URL(href, base).toString() : null
      } catch {
        url = null
      }
      if (url && /^https?:/.test(url)) {
        let n = index.get(url)
        if (n === undefined && links.length < MAX_LINKS) {
          links.push({ text: squash(el.textContent ?? '').slice(0, 120), url })
          n = links.length
          index.set(url, n)
        }
        if (n === undefined) dropped.add(url)
        if (n !== undefined) line += ` [${n}]`
      }
    }
    if (tag === 'td' || tag === 'th') line += ' | '
    if (block) flush()
  }
  walk(root)
  flush()
  return out.join('\n\n')
}

function scriptEvidence(doc: Document, text: string): boolean {
  if (text.length > 200) return false
  const noscript = Array.from(doc.querySelectorAll('noscript')).some((n) =>
    /javascript|enable js/i.test(n.textContent ?? '')
  )
  const appRoot = Array.from(doc.querySelectorAll('#root, #app, #__next, [data-reactroot]')).some(
    (n) => !squash(n.textContent ?? '')
  )
  return noscript || appRoot
}

export function extractHtml(html: string, url: string): Extracted {
  const { document } = parseHTML(html)
  const title = squash(document.querySelector('title')?.textContent ?? '')
  const links: Extracted['links'] = []
  const dropped = new Set<string>()
  // Readability changes the document it reads, so it gets its own copy.
  const article = new Readability(parseHTML(html).document as unknown as Document, {
    charThreshold: 200
  }).parse()
  let text = ''
  if (article?.content) {
    const { document: d } = parseHTML(
      `<!doctype html><html><head></head><body>${article.content}</body></html>`
    )
    text = toText(d.body as unknown as Element, url, links, dropped)
  }
  if (text.length < 200) {
    links.length = 0
    dropped.clear()
    const body = document.body as unknown as Element | null
    text = body ? toText(body, url, links, dropped) : ''
  }
  return {
    kind: 'html',
    title: squash(article?.title || title),
    text,
    links,
    ...(dropped.size ? { moreLinks: dropped.size } : {}),
    needsScript: scriptEvidence(document as unknown as Document, text)
  }
}

export function extract(body: Buffer, contentType: string | undefined, url: string): Extracted {
  const { mime, charset } = mimeOf(contentType)
  const text = decode(body, charset)
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return extractHtml(text, url)
  if (mime === 'application/json' || mime.endsWith('+json')) {
    try {
      return {
        kind: 'json',
        title: '',
        text: JSON.stringify(JSON.parse(text), null, 2),
        links: [],
        needsScript: false
      }
    } catch {
      return {
        kind: 'json',
        title: '',
        text: `(Not valid JSON, shown as is.)\n${text}`,
        links: [],
        needsScript: false
      }
    }
  }
  if (mime === 'text/markdown' || mime === 'text/x-markdown')
    return { kind: 'markdown', title: '', text, links: [], needsScript: false }
  // No declared type: read it as text unless it looks binary.
  if (mime === 'text/plain' || (mime === '' && !body.subarray(0, 1024).includes(0)))
    return { kind: 'text', title: '', text, links: [], needsScript: false }
  throw new ExtractError(
    `The page is ${mime || 'binary data'}, which web_read can't read. It reads web pages, plain text, Markdown and JSON.`
  )
}
