import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultDesignSettings,
  type Artifact,
  type DesignEvent,
  type Version
} from '../../../shared/design'
import { ArtifactStore } from '../store'
import type { DesignService, DesignToolContext } from '../tools'
import { checkAssets, checkDocument, HtmlError, planFiles } from './document'
import { exportVersion, type ExportDeps } from './export'
import { htmlHandler, type HtmlDeps, type PreviewCheck } from './handler'
import { allowedRequest, layout, PREVIEW_CSP, serveVersion } from './preview'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custard-html-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const CHAT = '11111111-2222-3333-4444-555555555555'
const PAGE = (body = 'Hello'): string =>
  `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`

function service(): DesignService & { events: DesignEvent[] } {
  const events: DesignEvent[] = []
  return {
    artifacts: new ArtifactStore(join(root, 'design')),
    jobs: null as never,
    providers: () => [],
    settings: () => defaultDesignSettings,
    failures: [],
    emit: (e) => void events.push(e),
    events
  }
}

const ctx = (over: Partial<DesignToolContext> = {}): DesignToolContext => ({
  conversationId: CHAT,
  messageIndex: 0,
  chat: { provider: 'claude', model: 'claude-opus-5-5', hasKey: true },
  approve: async () => {
    throw new Error('design_html never asks for approval')
  },
  references: async () => [],
  signal: new AbortController().signal,
  ...over
})

function vault(): string {
  const v = join(root, 'vault')
  const skill = (name: string, body: string, modes = ''): void => {
    mkdirSync(join(v, 'Custard/Skills', name), { recursive: true })
    writeFileSync(
      join(v, 'Custard/Skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} rules\n${modes}---\n${body}`
    )
  }
  skill('brand', 'Use amber.')
  skill('dark', 'Everything dark.')
  skill('light', 'Everything light.')
  return v
}

const deps = (over: Partial<HtmlDeps> = {}): HtmlDeps => ({
  vault: () => join(root, 'vault'),
  skills: () => [
    { path: 'Custard/Skills/brand/SKILL.md', name: 'brand' },
    { path: 'Custard/Skills/dark/SKILL.md', name: 'dark' },
    { path: 'Custard/Skills/light/SKILL.md', name: 'light' }
  ],
  attachment: async (_chat, id) => {
    if (id !== 'logo.png') throw new HtmlError(`There is no attached file "${id}" in this chat.`)
    return {
      id: 'att1',
      name: 'logo.png',
      mime: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71])
    }
  },
  ...over
})

describe('complete documents only', () => {
  it('accepts a whole document and refuses fragments and cut-off ones', () => {
    expect(() => checkDocument(PAGE())).not.toThrow()
    expect(() => checkDocument(`\uFEFF<!-- hi -->\n<html><body></body></html>\n`)).not.toThrow()
    expect(() => checkDocument('<div>hi</div>')).toThrow(/fragment/)
    expect(() => checkDocument('<!doctype html><html><body>cut')).toThrow(/incomplete/)
    expect(() => checkDocument(`<!doctype html><html>${'x'.repeat(2_000_001)}</html>`)).toThrow(
      /MB/
    )
  })

  it('checks local file paths and types', () => {
    const plan = (files: { path: string; content: string }[]): ReturnType<typeof planFiles> =>
      planFiles({ html: PAGE(), files, references: [], inherited: [] })
    expect(plan([{ path: './css/site.css', content: 'a{}' }]).map((f) => f.path)).toEqual([
      'index.html',
      'css/site.css'
    ])
    expect(() => plan([{ path: '../escape.css', content: '' }])).toThrow(/allowed/)
    expect(() => plan([{ path: 'run.exe', content: '' }])).toThrow(/type/)
    expect(() => plan([{ path: 'index.html', content: '' }])).toThrow(/document itself/)
    expect(() => plan([{ path: 'logo.png', content: 'x' }])).toThrow(/must be text/)
    expect(() =>
      plan([
        { path: 'a.css', content: '' },
        { path: 'A.css', content: '' }
      ])
    ).toThrow(/twice/)
  })

  it('finds missing local files and counts external ones', () => {
    const files = [
      { path: 'index.html', mime: 'text/html; charset=utf-8' },
      { path: 'css/site.css', mime: 'text/css; charset=utf-8' },
      { path: 'img/a.png', mime: 'image/png' }
    ]
    const text: Record<string, string> = {
      'index.html':
        '<link href="css/site.css"><img src="img/a.png"><img src="img/gone.png"><script src="https://cdn.example/x.js"></script><a href="#top">',
      'css/site.css': 'body{background:url(../img/a.png)} @import "fonts.css";'
    }
    expect(checkAssets(files, (p) => text[p])).toEqual({
      local: 4,
      missing: ['img/gone.png', 'css/fonts.css'],
      external: 1
    })
  })
})

describe('design_html', () => {
  it('saves a first version, then revisions and variations that keep local files', async () => {
    const s = service()
    const run = htmlHandler(deps())
    const r1 = await run(
      s,
      {
        name: 'Landing',
        html: PAGE('<link rel="stylesheet" href="site.css"><img src="assets/logo.png">'),
        files: [{ path: 'site.css', content: 'body{color:red}' }],
        references: [{ attachment: 'logo.png' }]
      },
      ctx()
    )
    expect(r1.outcome).toBe('completed')
    expect(r1.content).toMatch(/all 2 references resolve/)
    expect(r1.content).toMatch(/No skills applied/)
    // No preview check ran in this test, so none is claimed.
    expect(r1.content).not.toMatch(/Preview loaded/)
    const [a1] = s.artifacts.list(CHAT)
    expect(a1.versions[0].files.map((f) => f.path).sort()).toEqual([
      'assets/logo.png',
      'index.html',
      'site.css'
    ])
    expect(a1.versions[0].source).toEqual({
      kind: 'chat-model',
      provider: 'claude',
      model: 'claude-opus-5-5'
    })

    const r2 = await run(s, { artifact: a1.id, html: PAGE('v2') }, ctx())
    expect(r2.outcome).toBe('completed')
    const r3 = await run(
      s,
      { artifact: a1.id, from: a1.versions[0].id, relation: 'variation', html: PAGE('v3') },
      ctx()
    )
    expect(r3.outcome).toBe('completed')
    const a = s.artifacts.get(CHAT, a1.id)!
    expect(a.versions.map((v) => [v.n, v.relation, v.parent])).toEqual([
      [1, 'first', null],
      [2, 'revision', a.versions[0].id],
      [3, 'variation', a.versions[0].id]
    ])
    expect(a.selected).toBe(a.versions[2].id)
    // Revisions keep the earlier local files; the document is the new one.
    expect(a.versions[1].files.map((f) => f.path).sort()).toEqual([
      'assets/logo.png',
      'index.html',
      'site.css'
    ])
    expect(s.artifacts.read(CHAT, a.id, a.versions[1].id, 'index.html')!.toString()).toContain('v2')
    expect(s.artifacts.read(CHAT, a.id, a.versions[0].id, 'index.html')!.toString()).toContain(
      'logo'
    )
  })

  it('keeps the last good version when a new one is refused or fails', async () => {
    const s = service()
    const run = htmlHandler(deps())
    await run(s, { name: 'P', html: PAGE() }, ctx())
    const [a] = s.artifacts.list(CHAT)
    const bad = await run(s, { artifact: a.id, html: '<div>fragment</div>' }, ctx())
    expect(bad.outcome).toBe('not-run')
    expect(bad.content).toMatch(/Nothing was saved/)
    expect(s.artifacts.get(CHAT, a.id)!.versions).toHaveLength(1)
    // A storage failure is recorded as a failed version; v1 stays selected.
    const failing = {
      ...s,
      artifacts: Object.assign(Object.create(s.artifacts), {
        writeFiles: () => {
          throw new Error('Disk full.')
        }
      }) as ArtifactStore
    }
    const r = await run(failing, { artifact: a.id, html: PAGE('new') }, ctx())
    expect(r.outcome).toBe('failed')
    expect(r.content).toMatch(/Version 1 is still the one shown/)
    const after = s.artifacts.get(CHAT, a.id)!
    expect(after.versions.map((v) => v.status)).toEqual(['succeeded', 'failed'])
    expect(after.selected).toBe(after.versions[0].id)
  })

  it('refuses unknown outputs, other kinds and missing references', async () => {
    const s = service()
    const run = htmlHandler(deps())
    expect((await run(s, { artifact: 'nope', html: PAGE() }, ctx())).content).toMatch(
      /no such output/
    )
    expect(
      (await run(s, { html: PAGE(), references: [{ attachment: 'x.png' }] }, ctx())).content
    ).toMatch(/no attached file/)
    expect((await run(s, { html: 42 }, ctx())).outcome).toBe('not-run')
    expect(s.artifacts.list(CHAT)).toEqual([])
  })

  it('reports only the preview checks that ran', async () => {
    const s = service()
    const check = async (): Promise<PreviewCheck> => ({
      loaded: true,
      ms: 420,
      errors: ['Uncaught ReferenceError: x is not defined (line 3)'],
      blocked: 2,
      missing: []
    })
    const r = await htmlHandler(deps({ check }))(s, { html: PAGE() }, ctx())
    expect(r.content).toMatch(/Preview loaded in the sandbox in 0.4 s/)
    expect(r.content).toMatch(/ReferenceError/)
    expect(r.content).toMatch(/2 requests to outside the page blocked/)
    const hung = async (): Promise<PreviewCheck> => ({
      loaded: false,
      reason: "it didn't finish loading within 10 s, so it was stopped.",
      errors: []
    })
    const r2 = await htmlHandler(deps({ check: hung }))(s, { html: PAGE() }, ctx())
    expect(r2.content).toMatch(/didn't load: it didn't finish/)
    expect(r2.content).not.toMatch(/Preview loaded/)
  })
})

describe('skills in design_html', () => {
  it('records explicit and clear skills with fingerprints and guidance', async () => {
    vault()
    const s = service()
    const r = await htmlHandler(deps())(
      s,
      {
        html: PAGE(),
        skills: [
          { path: 'Custard/Skills/brand/SKILL.md', strength: 'explicit', guidance: 'amber' },
          { path: 'Custard/Skills/dark/SKILL.md', strength: 'clear', guidance: 'g'.repeat(5000) },
          { path: 'Custard/Skills/light/SKILL.md', strength: 'similar', material: false }
        ]
      },
      ctx()
    )
    expect(r.outcome).toBe('completed')
    expect(r.content).toMatch(/Used: brand, dark/)
    expect(r.content).toMatch(/"light" is related but not a clear fit/)
    const v = s.artifacts.list(CHAT)[0].versions[0]
    expect(v.skills.map((x) => [x.name, x.how])).toEqual([
      ['brand', 'explicit'],
      ['dark', 'matched']
    ])
    expect(v.skills[0].fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(v.skills[1].guidance).toHaveLength(2000)
  })

  it('asks about conflicting matches instead of generating', async () => {
    vault()
    const s = service()
    const r = await htmlHandler(deps())(
      s,
      {
        html: PAGE(),
        skills: [
          {
            path: 'Custard/Skills/dark/SKILL.md',
            strength: 'clear',
            conflicts: ['Custard/Skills/light/SKILL.md']
          },
          { path: 'Custard/Skills/light/SKILL.md', strength: 'clear' }
        ]
      },
      ctx()
    )
    expect(r.outcome).toBe('not-run')
    expect(r.content).toMatch(/Ask the user first.*disagree/)
    expect(s.artifacts.list(CHAT)).toEqual([])
  })

  it('says a named skill that is not available was not used', async () => {
    vault()
    const s = service()
    const r = await htmlHandler(deps())(
      s,
      { html: PAGE(), skills: [{ path: 'Custard/Skills/gone/SKILL.md', strength: 'explicit' }] },
      ctx()
    )
    expect(r.content).toMatch(/"gone" isn't available here/)
    expect(s.artifacts.list(CHAT)[0].versions[0].skills).toEqual([])
  })
})

describe('preview serving', () => {
  it('serves only recorded, unchanged files of one version', async () => {
    const s = service()
    await htmlHandler(deps())(
      s,
      { html: PAGE(), files: [{ path: 'js/app.js', content: 'console.log(1)' }] },
      ctx()
    )
    const a = s.artifacts.list(CHAT)[0]
    const t = { chat: CHAT, artifactId: a.id, versionId: a.versions[0].id }
    const missed: string[] = []
    const serve = serveVersion(s.artifacts, t, 'abc.preview.invalid', (p) => missed.push(p))
    const get = (url: string, method = 'GET'): Response => serve({ url, method })
    const index = get('https://abc.preview.invalid/')
    expect(index.status).toBe(200)
    expect(index.headers.get('content-security-policy')).toBe(PREVIEW_CSP)
    expect(PREVIEW_CSP).toMatch(/sandbox allow-scripts allow-same-origin$/)
    expect(PREVIEW_CSP).not.toMatch(/allow-(modals|popups|downloads|top-navigation)/)
    expect(index.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await index.text()).toContain('Hello')
    expect(get('https://abc.preview.invalid/js/app.js').headers.get('content-type')).toMatch(
      /javascript/
    )
    expect(get('https://abc.preview.invalid/js/app.js', 'POST').status).toBe(405)
    expect(get('https://other.preview.invalid/index.html').status).toBe(404)
    expect(get('https://abc.preview.invalid:444/index.html').status).toBe(404)
    expect(get('https://abc.preview.invalid/../../../etc/passwd').status).toBe(404)
    expect(get('https://abc.preview.invalid/%2e%2e/%2e%2e/artifacts.json').status).toBe(404)
    expect(get('https://abc.preview.invalid/js%2f..%2f..%2fartifacts.json').status).toBe(404)
    expect(missed.length).toBe(3)
    // A stored file changed on disk is not served.
    const dir = join(root, 'design', CHAT, a.id, a.versions[0].id)
    rmSync(join(dir, 'index.html'), { force: true })
    writeFileSync(join(dir, 'index.html'), 'tampered')
    expect(get('https://abc.preview.invalid/index.html').status).toBe(404)
  })

  it('lets through only its own origin, data: and blob:', () => {
    const o = 'https://abc.preview.invalid'
    expect(allowedRequest(`${o}/x.css`, o)).toBe(true)
    expect(allowedRequest('data:text/plain,hi', o)).toBe(true)
    expect(allowedRequest(`blob:${o}/1`, o)).toBe(true)
    for (const u of [
      'https://abc.preview.invalid.evil.com/',
      'https://example.com/',
      'http://127.0.0.1:8899/',
      'http://192.168.1.1/',
      'ws://localhost/',
      'file:///etc/passwd',
      'custard-media://chat/a/v/f.png',
      'http://169.254.169.254/latest/meta-data'
    ])
      expect(allowedRequest(u, o)).toBe(false)
  })

  it('fits a wider device width by zooming out, and centres a narrower one', () => {
    expect(layout({ x: 10, y: 20, width: 1000, height: 600 }, 390, 1)).toEqual({
      bounds: { x: 315, y: 20, width: 390, height: 600 },
      zoom: 1
    })
    expect(layout({ x: 0, y: 0, width: 400, height: 600 }, 800, 1)).toEqual({
      bounds: { x: 0, y: 0, width: 400, height: 600 },
      zoom: 0.5
    })
    expect(layout({ x: 0, y: 0, width: 500, height: 300 }, 0, 2).bounds).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 600
    })
  })
})

describe('export', () => {
  async function made(
    files: { path: string; content: string }[] = []
  ): Promise<{ s: DesignService; a: Artifact; v: Version }> {
    const s = service()
    await htmlHandler(deps())(s, { name: 'My Page!', html: PAGE(), files }, ctx())
    const a = s.artifacts.list(CHAT).at(-1)!
    return { s, a, v: a.versions[0] }
  }
  const out = (): string => {
    const d = join(root, 'out')
    mkdirSync(d, { recursive: true })
    return d
  }
  const exportDeps = (
    s: DesignService,
    pick: string | null,
    over: Partial<ExportDeps> = {}
  ): ExportDeps & { asked: string[] } => {
    const asked: string[] = []
    return {
      artifacts: s.artifacts,
      pick: async (o) => {
        asked.push(`pick ${o.defaultName}`)
        return pick
      },
      confirmReplace: async (p) => {
        asked.push(`replace ${p}`)
        return true
      },
      refuse: (p) => (p.includes('protected') ? 'Protected.' : null),
      asked,
      ...over
    }
  }

  it('saves a single page as a file and a page with files as a new folder', async () => {
    const one = await made()
    const d = out()
    const e1 = exportDeps(one.s, join(d, 'page.html'))
    expect(await exportVersion(e1, CHAT, one.a.id, one.v.id)).toEqual({
      ok: true,
      path: join(d, 'page.html'),
      files: 1
    })
    expect(e1.asked).toEqual(['pick my-page-v1.html'])
    expect(readFileSync(join(d, 'page.html'), 'utf8')).toContain('Hello')

    const two = await made([{ path: 'css/a.css', content: 'a{}' }])
    const v = two.a.versions[0]
    expect(
      await exportVersion(exportDeps(two.s, join(d, 'site')), CHAT, two.a.id, v.id)
    ).toMatchObject({
      ok: true,
      files: 2
    })
    expect(readdirSync(join(d, 'site')).sort()).toEqual(['css', 'index.html'])
    // Never merged into an existing folder.
    expect(
      await exportVersion(exportDeps(two.s, join(d, 'site')), CHAT, two.a.id, v.id)
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already exists/)
    })
  })

  it('asks before replacing, and replaces a link instead of writing through it', async () => {
    const { s, a, v } = await made()
    const d = out()
    const victim = join(root, 'victim.txt')
    writeFileSync(victim, 'keep me')
    symlinkSync(victim, join(d, 'page.html'))
    const declined = exportDeps(s, join(d, 'page.html'), { confirmReplace: async () => false })
    expect(await exportVersion(declined, CHAT, a.id, v.id)).toEqual({ ok: false, canceled: true })
    const e = exportDeps(s, join(d, 'page.html'))
    expect(await exportVersion(e, CHAT, a.id, v.id)).toMatchObject({ ok: true })
    expect(e.asked).toContain(`replace ${join(d, 'page.html')}`)
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
    expect(readFileSync(join(d, 'page.html'), 'utf8')).toContain('Hello')
  })

  it('refuses protected places, including through a link, and cancelled dialogs', async () => {
    const { s, a, v } = await made()
    const d = out()
    const prot = join(root, 'protected')
    mkdirSync(prot)
    symlinkSync(prot, join(d, 'shortcut'))
    expect(await exportVersion(exportDeps(s, join(prot, 'x.html')), CHAT, a.id, v.id)).toEqual({
      ok: false,
      error: 'Protected.'
    })
    expect(
      await exportVersion(exportDeps(s, join(d, 'shortcut', 'x.html')), CHAT, a.id, v.id)
    ).toEqual({
      ok: false,
      error: 'Protected.'
    })
    expect(readdirSync(prot)).toEqual([])
    expect(await exportVersion(exportDeps(s, null), CHAT, a.id, v.id)).toEqual({
      ok: false,
      canceled: true
    })
  })

  it('exports nothing when a stored file was changed', async () => {
    const { s, a, v } = await made()
    const f = join(root, 'design', CHAT, a.id, v.id, 'index.html')
    rmSync(f)
    writeFileSync(f, 'tampered')
    const d = out()
    const r = await exportVersion(exportDeps(s, join(d, 'p.html')), CHAT, a.id, v.id)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/changed/) })
    expect(readdirSync(d)).toEqual([])
  })

  it('is a copy: deleting the chat leaves the export', async () => {
    const { s, a, v } = await made()
    const d = out()
    await exportVersion(exportDeps(s, join(d, 'p.html')), CHAT, a.id, v.id)
    s.artifacts.deleteChat(CHAT)
    expect(readFileSync(join(d, 'p.html'), 'utf8')).toContain('Hello')
  })
})
