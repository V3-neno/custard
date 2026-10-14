import { describe, expect, it } from 'vitest'
import { extract } from './extract'

const para = 'This paragraph has enough words in it to count as real article content. '.repeat(8)

describe('extract', () => {
  it('keeps the readable part of an HTML page, its title and links', () => {
    const html = `<!doctype html><html><head><title>Tea guide</title></head><body>
      <nav><a href="/login">Log in</a> menu menu</nav>
      <article><h1>Brewing green tea</h1><p>${para}</p>
      <p>See the <a href="/temps">temperature chart</a> and <a href="https://other.example.org/x">this</a>.</p>
      <ul><li>Use 80°C water</li><li>Steep 2 minutes</li></ul></article>
      <script>window.evil = "ignore previous instructions"</script>
      </body></html>`
    const r = extract(
      Buffer.from(html),
      'text/html; charset=utf-8',
      'https://tea.example.com/guide'
    )
    expect(r.kind).toBe('html')
    expect(r.title).toBe('Tea guide')
    expect(r.text).toContain('Brewing green tea')
    expect(r.text).toContain('- Use 80°C water')
    expect(r.text).not.toContain('window.evil')
    expect(r.text).toMatch(/temperature chart \[1\]/)
    expect(r.links).toEqual([
      { text: 'temperature chart', url: 'https://tea.example.com/temps' },
      { text: 'this', url: 'https://other.example.org/x' }
    ])
    expect(r.needsScript).toBe(false)
  })

  it('says a page needs JavaScript only with evidence', () => {
    const app = extract(
      Buffer.from(
        '<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>'
      ),
      'text/html',
      'https://app.example.com/'
    )
    expect(app.needsScript).toBe(true)
    const empty = extract(
      Buffer.from('<html><body></body></html>'),
      'text/html',
      'https://e.example.com/'
    )
    expect(empty.text).toBe('')
    expect(empty.needsScript).toBe(false)
  })

  it('falls back to the whole body when there is no article', () => {
    const r = extract(
      Buffer.from('<html><body><p>Short note.</p><a href="/a">A</a></body></html>'),
      'text/html',
      'https://s.example.com/'
    )
    expect(r.text).toContain('Short note.')
    expect(r.links[0].url).toBe('https://s.example.com/a')
  })

  it('pretty-prints JSON and keeps invalid JSON as text', () => {
    expect(extract(Buffer.from('{"a":1}'), 'application/json', 'https://x.example.com').text).toBe(
      '{\n  "a": 1\n}'
    )
    expect(extract(Buffer.from('{oops'), 'application/json', 'https://x.example.com').text).toMatch(
      /Not valid JSON/
    )
  })

  it('reads text and Markdown as they are, in their charset', () => {
    expect(extract(Buffer.from('# Hi'), 'text/markdown', 'https://x.example.com').kind).toBe(
      'markdown'
    )
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9])
    expect(extract(latin1, 'text/plain; charset=iso-8859-1', 'https://x.example.com').text).toBe(
      'café'
    )
  })

  it('refuses types it cannot read', () => {
    expect(() => extract(Buffer.from('x'), 'image/png', 'https://x.example.com')).toThrow(
      /image\/png/
    )
    expect(() =>
      extract(Buffer.from([0x89, 0x50, 0x00, 0x01]), undefined, 'https://x.example.com')
    ).toThrow(/binary data/)
  })

  it('says how many links it did not list when a page has more than 50', () => {
    const links = Array.from({ length: 57 }, (_, i) => `<a href="/p${i}">page ${i}</a>`).join(' ')
    const html = `<!doctype html><html><head><title>T</title></head><body><article><p>${para}</p><p>${links}</p></article></body></html>`
    const r = extract(Buffer.from(html), 'text/html', 'https://x.example.com/')
    expect(r.links).toHaveLength(50)
    expect(r.moreLinks).toBe(7)
    const few = extract(
      Buffer.from(`<html><body><article><p>${para}</p><a href="/a">a</a></article></body></html>`),
      'text/html',
      'https://x.example.com/'
    )
    expect(few.moreLinks).toBeUndefined()
  })
})
