import { describe, expect, it } from 'vitest'
import {
  parseScriptManifest,
  scriptToolName,
  splitScriptToolName,
  versionAtLeast
} from './manifest'
import { PLUGIN_ID, splitToolName } from '../plugins/manifest'

const tool = {
  name: 'fetch_page',
  description: 'Fetch a page.',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  effect: 'read'
}
const good = {
  name: 'Scraper',
  version: '0.1.0',
  runtime: 'python',
  minVersion: '3.10',
  entry: 'main.py',
  setup: [['python', '-m', 'scrapling', 'install']],
  tools: [tool],
  declares: { network: true }
}

describe('script.json', () => {
  it('accepts a valid manifest and fills defaults', () => {
    const r = parseScriptManifest(good, 'scraper')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.id).toBe('scraper')
    expect(r.manifest.declares).toEqual({ network: true, files: 'work' })
    expect(r.manifest.setup).toEqual([['python', '-m', 'scrapling', 'install']])
  })

  it('refuses entries outside the folder or of the wrong kind', () => {
    for (const entry of [
      '../main.py',
      '/abs/main.py',
      'C:/x.py',
      'main.js',
      'a\\b.py',
      'a/../b.py'
    ])
      expect(parseScriptManifest({ ...good, entry }, 'scraper').ok).toBe(false)
    expect(
      parseScriptManifest({ ...good, runtime: 'node', entry: 'lib/main.mjs', setup: [] }, 'scraper')
        .ok
    ).toBe(true)
  })

  it('refuses setup commands that use another program or shell syntax', () => {
    const bad = [
      [['pip', 'install', 'x']],
      [['python', '-c', 'import os; os.system("x")']],
      [['python', '-m', 'x', '&&', 'del']],
      [['python']],
      'python -m x'
    ]
    for (const setup of bad)
      expect(parseScriptManifest({ ...good, setup }, 'scraper').ok).toBe(false)
  })

  it('checks tools like plugins do, with a longer timeout ceiling', () => {
    expect(parseScriptManifest({ ...good, tools: [] }, 'scraper').ok).toBe(false)
    expect(
      parseScriptManifest({ ...good, tools: [{ ...tool, effect: 'delete' }] }, 'scraper').ok
    ).toBe(false)
    expect(parseScriptManifest({ ...good, tools: [tool, tool] }, 'scraper').ok).toBe(false)
    expect(
      parseScriptManifest({ ...good, tools: [{ ...tool, timeoutMs: 600_000 }] }, 'scraper').ok
    ).toBe(true)
    expect(
      parseScriptManifest({ ...good, tools: [{ ...tool, timeoutMs: 600_001 }] }, 'scraper').ok
    ).toBe(false)
  })

  it('refuses unknown fields, bad ids and bad declarations', () => {
    expect(parseScriptManifest({ ...good, shell: true }, 'scraper').ok).toBe(false)
    expect(parseScriptManifest(good, 'Scraper').ok).toBe(false)
    expect(parseScriptManifest(good, 'a_b').ok).toBe(false)
    expect(parseScriptManifest({ ...good, declares: { files: 'vault' } }, 'scraper').ok).toBe(false)
  })
})

describe('script tool names', () => {
  it('round-trip and never parse as plugin tools', () => {
    const n = scriptToolName('scraper', 'fetch_page')
    expect(n).toBe('script_scraper__fetch_page')
    expect(splitScriptToolName(n)).toEqual({ scriptId: 'scraper', tool: 'fetch_page' })
    // Plugin ids can't contain "_", so no plugin can own this name.
    expect(PLUGIN_ID.test(splitToolName(n)!.pluginId)).toBe(false)
    expect(splitScriptToolName('spotify__play')).toBeNull()
  })
})

describe('versionAtLeast', () => {
  it('compares numerically', () => {
    expect(versionAtLeast([3, 10, 0], '3.9')).toBe(true)
    expect(versionAtLeast([3, 9, 18], '3.10')).toBe(false)
    expect(versionAtLeast([22, 1, 0], '20')).toBe(true)
    expect(versionAtLeast([3, 13, 1], undefined)).toBe(true)
  })
})
