import { describe, expect, it } from 'vitest'
import {
  fullToolName,
  parseManifest,
  permissionsOf,
  splitToolName,
  validOpenPrefix
} from './manifest'
import { checkSchema, validate } from './schema'

export const goodManifest = (): Record<string, unknown> => ({
  manifestVersion: 1,
  id: 'demo',
  name: 'Demo',
  description: 'A demo plugin',
  version: '1.0.0',
  apiVersion: 1,
  entry: 'src/index.ts',
  permissions: {
    network: ['api.example.com', 'auth.example.com'],
    openExternal: ['spotify:'],
    storage: true
  },
  config: {
    clientId: { type: 'string', title: 'Client ID', pattern: '^[a-z0-9]+$' },
    apiKey: { type: 'string', title: 'API key', secret: true }
  },
  auth: {
    type: 'oauth-pkce',
    authorizeUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    redirectPort: 43999,
    redirectPath: '/callback',
    scopes: ['read', 'write'],
    clientIdConfigKey: 'clientId',
    apiHosts: ['api.example.com']
  },
  tools: [
    {
      name: 'search',
      description: 'Search',
      effect: 'read',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    },
    {
      name: 'act',
      description: 'Do it',
      effect: 'write',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
})

const errorsFor = (patch: (m: Record<string, unknown>) => void, folder?: string): string[] => {
  const m = goodManifest()
  patch(m)
  return parseManifest(m, folder).errors
}

describe('manifest', () => {
  it('accepts a valid manifest', () => {
    const r = parseManifest(goodManifest(), 'demo')
    expect(r.errors).toEqual([])
    expect(r.manifest?.tools.map((t) => t.name)).toEqual(['search', 'act'])
  })

  it.each<[string, (m: Record<string, unknown>) => void, RegExp]>([
    ['bad id', (m) => (m.id = 'Demo_1'), /id must be/],
    ['unsupported api', (m) => (m.apiVersion = 2), /apiVersion 2 is not supported/],
    ['bad version', (m) => (m.version = 'v1'), /semver/],
    ['entry escapes', (m) => (m.entry = '../core/main.ts'), /entry/],
    [
      'unknown field',
      (m) => (m.scripts = { postinstall: 'x' }),
      /"scripts" is not a manifest field/
    ],
    [
      'unknown permission',
      (m) => ((m.permissions as Record<string, unknown>).shell = true),
      /permissions.shell/
    ],
    [
      'ip literal host',
      (m) => ((m.permissions as Record<string, unknown>).network = ['127.0.0.1']),
      /host name/
    ],
    [
      'localhost',
      (m) => ((m.permissions as Record<string, unknown>).network = ['localhost']),
      /host name/
    ],
    [
      'file scheme',
      (m) => ((m.permissions as Record<string, unknown>).openExternal = ['file:']),
      /openExternal/
    ],
    [
      'scheme that runs commands or remote files (L20)',
      (m) => ((m.permissions as Record<string, unknown>).openExternal = ['search:']),
      /openExternal/
    ],
    [
      'remote help or archive scheme (L20)',
      (m) => ((m.permissions as Record<string, unknown>).openExternal = ['its:']),
      /openExternal/
    ],
    [
      'editor scheme that can open a shell (L20)',
      (m) => ((m.permissions as Record<string, unknown>).openExternal = ['vscode:']),
      /openExternal/
    ],
    [
      'duplicate tools',
      (m) => (m.tools as unknown[]).push((m.tools as unknown[])[0]),
      /duplicate tool name/
    ],
    [
      'dotted tool name',
      (m) => ((m.tools as { name: string }[])[0].name = 'spotify.search'),
      /name must be/
    ],
    [
      'schema keyword',
      (m) => ((m.tools as { inputSchema: Record<string, unknown> }[])[0].inputSchema.$ref = '#'),
      /"\$ref" is not supported/
    ],
    [
      'non-object input',
      (m) => ((m.tools as { inputSchema: unknown }[])[0].inputSchema = { type: 'string' }),
      /type must be "object"/
    ],
    ['bad effect', (m) => ((m.tools as { effect: string }[])[0].effect = 'maybe'), /effect/],
    [
      'token host not allowed',
      (m) => ((m.auth as Record<string, unknown>).apiHosts = ['evil.example.org']),
      /apiHosts/
    ],
    [
      'secret client id',
      (m) => ((m.config as Record<string, { secret?: boolean }>).clientId.secret = true),
      /clientIdConfigKey/
    ],
    [
      'non-string secret',
      (m) =>
        ((m.config as Record<string, unknown>).n = { type: 'number', title: 'N', secret: true }),
      /only string fields/
    ]
  ])('rejects %s', (_, patch, re) => {
    expect(errorsFor(patch).join('\n')).toMatch(re)
  })

  it('requires the id to match its folder', () => {
    expect(errorsFor(() => {}, 'other').join()).toMatch(/must match its folder/)
  })

  it('rejects a tool name that would exceed 64 characters', () => {
    const r = errorsFor((m) => {
      m.id = 'p'.repeat(30)
      ;(m.tools as { name: string }[])[0].name = 'a'.repeat(40)
    })
    expect(r.join()).toMatch(/longer than 64/)
  })

  it('lists permissions, including write actions and account scopes', () => {
    const m = parseManifest(goodManifest()).manifest!
    expect(permissionsOf(m)).toEqual([
      'network:api.example.com',
      'network:auth.example.com',
      'open:spotify:',
      'storage',
      'account:auth.example.com',
      'account-token:auth.example.com',
      'account-api:api.example.com',
      'account-scope:read',
      'account-scope:write',
      'action:act'
    ])
  })

  it('namespaces tool names for the providers', () => {
    expect(fullToolName('spotify', 'search')).toBe('spotify__search')
    expect(fullToolName('spotify', 'search')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(splitToolName('spotify__add_to_queue')).toEqual({
      pluginId: 'spotify',
      tool: 'add_to_queue'
    })
    expect(splitToolName('vault_read')).toBeNull()
  })

  it('only allows safe open prefixes', () => {
    expect(validOpenPrefix('spotify:')).toBe(true)
    expect(validOpenPrefix('https://open.spotify.com/')).toBe(true)
    for (const p of [
      'file:',
      'javascript:',
      'http://x.com/',
      'ms-settings:',
      'https://open.spotify.com',
      'spotify:track'
    ])
      expect(validOpenPrefix(p)).toBe(false)
  })
})

describe('schema', () => {
  const s = {
    type: 'object' as const,
    properties: {
      uris: {
        type: 'array' as const,
        items: { type: 'string' as const, pattern: '^spotify:track:' },
        minItems: 1,
        maxItems: 2
      },
      n: { type: 'integer' as const, minimum: 1, maximum: 10 },
      mode: { type: 'string' as const, enum: ['a', 'b'] }
    },
    required: ['uris'],
    additionalProperties: false
  }
  it('validates input', () => {
    expect(validate(s, { uris: ['spotify:track:x'] })).toEqual([])
    expect(validate(s, {})).toEqual(['input.uris is required'])
    expect(validate(s, { uris: ['x'] })[0]).toMatch(/wrong format/)
    expect(
      validate(s, { uris: ['spotify:track:1', 'spotify:track:2', 'spotify:track:3'] })[0]
    ).toMatch(/at most 2/)
    expect(validate(s, { uris: ['spotify:track:1'], n: 1.5 })[0]).toMatch(/integer/)
    expect(validate(s, { uris: ['spotify:track:1'], n: 11 })[0]).toMatch(/at most 10/)
    expect(validate(s, { uris: ['spotify:track:1'], mode: 'c' })[0]).toMatch(/one of/)
    expect(validate(s, { uris: ['spotify:track:1'], extra: 1 })[0]).toMatch(/not allowed/)
    expect(validate(s, 'nope')[0]).toMatch(/must be a object/)
  })
  it('rejects unsupported or broken schemas', () => {
    expect(checkSchema({ type: 'object', oneOf: [] })).toHaveLength(1)
    expect(checkSchema({ type: 'string', pattern: '(' })[0]).toMatch(/regular expression/)
    expect(checkSchema({ properties: {} })[0]).toMatch(/"type" is required/)
  })
})

describe('manifest widgets', () => {
  const widget = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'panel',
    title: 'Panel',
    description: 'A panel.',
    widgetApi: 1,
    entry: 'widget/panel.ts',
    tools: ['search', 'act'],
    ...over
  })
  const withWidgets = (...w: unknown[]): string[] => errorsFor((m) => (m.widgets = w))

  it('accepts a well-formed widget and asks for its own permission', () => {
    const m = goodManifest()
    m.widgets = [
      widget({
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        height: { initial: 100, min: 60, max: 200 },
        presentations: ['compact', 'expanded'],
        refreshSeconds: 30
      })
    ]
    const r = parseManifest(m)
    expect(r.errors).toEqual([])
    expect(r.manifest!.widgets![0].id).toBe('panel')
    expect(permissionsOf(r.manifest!)).toContain('widget:panel')
  })

  it('refuses a widget API this Custard does not support', () => {
    expect(withWidgets(widget({ widgetApi: 2 })).join(' ')).toMatch(/widgetApi 2 is not supported/)
  })

  it("only lets a widget use its own plugin's tools", () => {
    expect(withWidgets(widget({ tools: ['other__search'] })).join(' ')).toMatch(
      /not one of this plugin's tools/
    )
  })

  it('checks ids, entry, sizes, presentations, refresh and unknown fields', () => {
    const all = [
      withWidgets(widget({ id: 'Bad Id' })),
      withWidgets(widget(), widget()),
      withWidgets(widget({ entry: '../outside.ts' })),
      withWidgets(widget({ height: { initial: 500 } })),
      withWidgets(widget({ height: { min: 200, max: 100 } })),
      withWidgets(widget({ presentations: ['huge'] })),
      withWidgets(widget({ refreshSeconds: 1 })),
      withWidgets(widget({ inputSchema: { type: 'string' } })),
      withWidgets(widget({ html: '<b>' }))
    ]
    for (const errors of all) expect(errors.length).toBeGreaterThan(0)
  })
})

describe('fills', () => {
  it('is optional, and kept when it names a capability and one of its tools', () => {
    expect(parseManifest(goodManifest()).manifest?.fills).toBeUndefined()
    const r = parseManifest({
      ...goodManifest(),
      fills: [{ capability: 'web_search', tool: 'search' }]
    })
    expect(r.errors).toEqual([])
    expect(r.manifest?.fills).toEqual([{ capability: 'web_search', tool: 'search' }])
  })

  it('refuses a capability no plugin can fill, a missing tool and extra fields', () => {
    const errs = (fills: unknown): string[] => parseManifest({ ...goodManifest(), fills }).errors
    expect(errs([{ capability: 'compaction', tool: 'search' }])[0]).toMatch(
      /capability must be one of web_search, pdf, vision/
    )
    expect(errs([{ capability: 'pdf', tool: 'nope' }])[0]).toMatch(
      /must name one of this plugin's tools/
    )
    expect(errs([{ capability: 'pdf', tool: 'search', auto: true }])[0]).toMatch(
      /auto is not a field/
    )
    expect(errs([])[0]).toMatch(/fills must be a list/)
    expect(errs('web_search')[0]).toMatch(/fills must be a list/)
    expect(
      errs([
        { capability: 'pdf', tool: 'search' },
        { capability: 'pdf', tool: 'search' }
      ])[0]
    ).toMatch(/repeats pdf/)
  })
})
