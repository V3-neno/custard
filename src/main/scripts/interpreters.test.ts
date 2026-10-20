import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import {
  candidates,
  checkInterpreter,
  defaultDeps,
  discover,
  isStoreAlias,
  parsePyList,
  type DiscoverDeps
} from './interpreters'

const winDeps = (files: Record<string, string>, pyList = ''): DiscoverDeps => ({
  platform: 'win32',
  env: {
    Path: 'C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python311;C:\\Windows',
    ProgramFiles: 'C:\\Program Files'
  },
  exists: (p) => p in files || p === 'C:\\Windows\\py.exe',
  probe: async (file, args) => {
    if (file.endsWith('py.exe') && args[0] === '-0p') return { code: 0, stdout: pyList }
    const v = files[file]
    return v ? { code: 0, stdout: `${v}\n` } : { code: 1, stdout: '' }
  }
})

describe('interpreter discovery (Windows, simulated)', () => {
  it('reads the launcher list in both formats', () => {
    expect(
      parsePyList(
        ' -V:3.12 *        C:\\Python312\\python.exe\r\n -V:3.10          C:\\Users\\n\\AppData\\Local\\Programs\\Python\\Python310\\python.exe\r\n'
      )
    ).toEqual([
      'C:\\Python312\\python.exe',
      'C:\\Users\\n\\AppData\\Local\\Programs\\Python\\Python310\\python.exe'
    ])
    expect(parsePyList(' -3.9-64 *  C:\\Py39\\python.exe')).toEqual(['C:\\Py39\\python.exe'])
  })

  it('skips the Microsoft Store alias and picks the newest Python', async () => {
    const files = {
      'C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe': '3.99.0',
      'C:\\Python311\\python.exe': '3.11.4',
      'C:\\Python312\\python.exe': '3.12.1'
    }
    const d = winDeps(files, ' -V:3.12 *  C:\\Python312\\python.exe\r\n')
    expect(await candidates('python', d)).toEqual([
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe'
    ])
    const found = await discover('python', d)
    expect(found.map((f) => f.path)).toEqual([
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe'
    ])
    expect(found[0].version).toEqual([3, 12, 1])
    expect(isStoreAlias('C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe')).toBe(
      true
    )
  })

  it('finds Node in Program Files when it is not on PATH', async () => {
    const d = winDeps({ 'C:\\Program Files\\nodejs\\node.exe': '22.11.0' })
    const found = await discover('node', d)
    expect(found).toEqual([
      { runtime: 'node', path: 'C:\\Program Files\\nodejs\\node.exe', version: [22, 11, 0] }
    ])
  })

  it('refuses a picked path that is the Store alias or does not run', async () => {
    const d = winDeps({
      'C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe': '3.12.0'
    })
    expect(
      await checkInterpreter(
        'python',
        'C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe',
        d
      )
    ).toBeNull()
    expect(await checkInterpreter('python', 'C:\\nope\\python.exe', d)).toBeNull()
  })
})

describe('interpreter discovery (this machine)', () => {
  it('finds the real Python and Node and reads their versions', async () => {
    const py = await discover('python', defaultDeps())
    const node = await discover('node', defaultDeps())
    expect(py.length).toBeGreaterThan(0)
    expect(node.length).toBeGreaterThan(0)
    const real = execFileSync(py[0].path, ['-c', 'import sys; print(sys.version_info[0])'])
      .toString()
      .trim()
    expect(String(py[0].version[0])).toBe(real)
    expect(node.some((n) => n.version[0] === Number(process.versions.node.split('.')[0]))).toBe(
      true
    )
  })
})
