import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { readSettingsFile, writeSettingsFile } from './settingsFile'

// L2: settings.json is replaced whole, never left half-written, and a file
// that can't be read is kept aside instead of being overwritten by defaults.

describe('settings.json', () => {
  it('writes through a temporary file and leaves no temporary behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'custard-settings-'))
    const path = join(dir, 'settings.json')
    writeSettingsFile(path, { vaultPath: '/v' })
    writeSettingsFile(path, { vaultPath: '/w', extra: 1 })
    expect(readSettingsFile(path)).toEqual({ vaultPath: '/w', extra: 1 })
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('keeps an unreadable file aside rather than replacing it with defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'custard-settings-'))
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{"vaultPath": "/my/vault", "chat": {"mod')
    expect(readSettingsFile(path)).toEqual({})
    const aside = readdirSync(dir).find((f) => f.startsWith('settings.json.unreadable-'))
    expect(aside).toBeTruthy()
    expect(readFileSync(join(dir, aside!), 'utf8')).toContain('/my/vault')
    writeSettingsFile(path, { vaultPath: null })
    expect(existsSync(join(dir, aside!))).toBe(true)
  })

  it('treats a missing file as first run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'custard-settings-'))
    expect(readSettingsFile(join(dir, 'settings.json'))).toEqual({})
    expect(readdirSync(dir)).toEqual([])
  })
})
