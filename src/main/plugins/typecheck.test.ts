import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import * as ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_TYPE_ERRORS, typecheck } from './typecheck'

const SDK = resolve(__dirname, '../../plugin-sdk')
const libDir = dirname(require.resolve('typescript/lib/typescript.js'))
let dir = ''
let outside = ''

const put = (p: string, text: string): void => {
  mkdirSync(join(dir, p, '..'), { recursive: true })
  writeFileSync(join(dir, p), text)
}
const check = (widgetEntries: string[] = []): string[] =>
  typecheck(ts, { dir, sdkDir: SDK, libDir, widgetEntries })

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'custard-tc-'))
  dir = join(base, 'plugin')
  outside = join(base, 'secret')
  mkdirSync(dir)
  mkdirSync(outside)
})
afterEach(() => rmSync(dirname(dir), { recursive: true, force: true }))

describe('the plugin type check', () => {
  it('passes a plugin that uses the SDK and the sandbox globals correctly', () => {
    put(
      'src/index.ts',
      `import { definePlugin } from 'custard-plugin-sdk'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export const n: number = new URL('https://a.example/x').pathname.length
export default { wait }\n`
    )
    expect(check()).toEqual([])
  })
  it('reports a wrong type with file, line and code', () => {
    put('src/a.ts', `export const n: number = 'x'\n`)
    expect(check()).toEqual([
      expect.stringMatching(
        /^src\/a\.ts:1: TS2322: Type 'string' is not assignable to type 'number'/
      )
    ])
  })
  it('reports a misspelt SDK import and a missing file', () => {
    put(
      'src/a.ts',
      `import { nope } from 'custard-plugin-sdk'\nimport { x } from './missing'\nvoid nope\nvoid x\n`
    )
    const out = check().join('\n')
    expect(out).toMatch(/TS2305/)
    expect(out).toMatch(/TS2307.*missing/)
  })
  it('plugin code has no fetch or document, but widgets and tests have the DOM', () => {
    put('src/a.ts', `void fetch('https://x.example')\nvoid document.title\n`)
    put('widget/w.ts', `export const el: HTMLElement = document.createElement('div')\n`)
    put('tests/t.test.ts', `void document.title\n`)
    const out = check(['widget/w.ts'])
    expect(out.filter((l) => l.startsWith('src/a.ts')).map((l) => l.match(/'(\w+)'/)?.[1])).toEqual(
      ['fetch', 'document']
    )
    expect(out.filter((l) => !l.startsWith('src/a.ts'))).toEqual([])
  })
  it('cannot be made to read a file outside the plugin, the SDK and the compiler libraries', () => {
    writeFileSync(join(outside, 'secret.ts'), `export const SECRET_VALUE: number = 'leaked'\n`)
    put(
      'src/a.ts',
      `import { SECRET_VALUE } from '../../secret/secret'\nimport '${outside.replace(/\\/g, '/')}/secret'\nvoid SECRET_VALUE\n`
    )
    const out = check().join('\n')
    expect(out).toMatch(/TS2307/)
    expect(out).not.toMatch(/leaked|SECRET_VALUE.*string/)
  })
  it('cuts a long list with a count', () => {
    put(
      'src/a.ts',
      Array.from({ length: 50 }, (_, i) => `export const v${i}: number = 's'`).join('\n')
    )
    const out = check()
    expect(out).toHaveLength(MAX_TYPE_ERRORS + 1)
    expect(out.at(-1)).toMatch(/\[… 20 more type errors left out/)
  })
})

describe('a compiler without its library files', () => {
  it('says the check cannot run instead of reporting errors in every file', () => {
    put('src/a.ts', 'export const n = 1\n')
    expect(() => typecheck(ts, { dir, sdkDir: SDK, libDir: outside })).toThrow(/library files/)
  })
})
