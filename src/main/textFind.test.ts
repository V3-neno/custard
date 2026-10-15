import { describe, expect, it } from 'vitest'
import { find, findQuery, FIND_LIMITS, formatFound, outline, sections, words } from './textFind'

const filler = (topic: string, n: number): string =>
  Array.from(
    { length: n },
    (_, i) =>
      `Paragraph ${i} about ${topic}. It goes on for a while with ordinary words so the section has some length to it and reads like a real page would read.`
  ).join('\n\n')

// A page shaped like an extracted docs page: headings, then paragraphs.
const page = [
  '# Acme Cloud',
  filler('the company history', 8),
  '## Pricing',
  filler('plans in general', 6),
  '### Teams',
  'The Teams plan costs 12 euros per seat per month, billed yearly, with SSO included.',
  filler('team features', 4),
  '## Support',
  filler('opening hours and contact', 8)
].join('\n\n')

describe('sections', () => {
  it('cover all of the text, in order, with their heading path', () => {
    const s = sections(page)
    expect(s[0].start).toBe(0)
    expect(s.at(-1)?.end).toBe(page.length)
    // Only blank lines fall between sections.
    for (let i = 1; i < s.length; i++) expect(page.slice(s[i - 1].end, s[i].start).trim()).toBe('')
    const teams = s.find((x) => page.slice(x.start, x.end).includes('12 euros'))
    expect(teams?.heading).toBe('Acme Cloud > Pricing > Teams')
    expect(s.every((x) => x.end - x.start <= FIND_LIMITS.section * 1.5 + 200)).toBe(true)
  })

  it('cut a text with no line breaks at spaces', () => {
    const flat = 'word '.repeat(2_000)
    const s = sections(flat)
    expect(s.length).toBeGreaterThan(3)
    expect(s.every((x) => x.end - x.start <= FIND_LIMITS.section * 1.5)).toBe(true)
    expect(s.at(-1)?.end).toBe(flat.length)
  })
})

describe('find', () => {
  it('returns the section that answers, with its offset and heading', () => {
    const found = find(page, 'price of the Teams plan per seat')
    expect(found).not.toBeNull()
    const hit = found!.find((f) => f.text.includes('12 euros'))
    expect(hit).toBeDefined()
    expect(page.slice(hit!.start, hit!.end).trim()).toBe(hit!.text)
    expect(hit!.heading).toContain('Teams')
  })

  it('stays within its budget and keeps text order', () => {
    const found = find(page, 'paragraph ordinary words page', 3_000)!
    expect(found.reduce((n, f) => n + (f.end - f.start), 0)).toBeLessThanOrEqual(3_000)
    expect(found.length).toBeLessThanOrEqual(FIND_LIMITS.maxSections)
    for (let i = 1; i < found.length; i++)
      expect(found[i].start).toBeGreaterThan(found[i - 1].start)
  })

  it('ignores case, accents and small words', () => {
    expect(words('The Café IS open')).toEqual(['cafe', 'open'])
    expect(find('Notre café ouvre à 8h.\n\nAutre chose.', 'CAFE')).toHaveLength(1)
  })

  it('finds nothing when no word matches, or the query has none', () => {
    expect(find(page, 'kubernetes')).toBeNull()
    expect(find(page, 'the of and')).toBeNull()
  })

  it('formats each part with where it is', () => {
    const out = formatFound(find(page, 'Teams plan seat')!)
    expect(out).toMatch(/\[characters [\d,]+–[\d,]+ · under "Acme Cloud > Pricing > Teams"\]/)
  })
})

describe('outline', () => {
  it('lists headings with the offset each starts at', () => {
    const o = outline(page)
    const m = /- Teams \(offset (\d+)\)/.exec(o)
    expect(m).not.toBeNull()
    expect(page.slice(Number(m![1])).startsWith('### Teams')).toBe(true)
    expect(o).toContain('    - Teams')
  })

  it('is empty for a text without headings', () => {
    expect(outline('just text\n\nmore text')).toBe('')
  })
})

describe('the query', () => {
  it('is trimmed, bounded, and absent when empty', () => {
    expect(findQuery('  pricing ')).toBe('pricing')
    expect(findQuery('')).toBeNull()
    expect(findQuery(3)).toBeNull()
    expect(findQuery('x'.repeat(500))).toHaveLength(FIND_LIMITS.query)
  })
})
