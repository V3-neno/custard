import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { PluginStore, SecretsLockedError } from './store'

// M7: secrets that can't be decrypted right now are not "no secrets". They
// are kept byte for byte, and nothing replaces them until they can be read
// again or the user resets them.

const working = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString().slice(4)
}
const refusing = {
  ...working,
  decrypt: (): string => {
    throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
  }
}

function stores(): { base: string; ok: PluginStore; locked: PluginStore; file: string } {
  const base = mkdtempSync(join(tmpdir(), 'custard-secrets-'))
  return {
    base,
    ok: new PluginStore(base, working),
    locked: new PluginStore(base, refusing),
    file: join(base, 'demo', 'secrets.bin')
  }
}

describe('plugin secrets when secure storage refuses', () => {
  it('reports them as locked, not empty', () => {
    const { ok, locked } = stores()
    ok.setSecret('demo', 'apiKey', 'sk-1')
    expect(() => locked.secrets('demo')).toThrow(SecretsLockedError)
    expect(locked.secretsLocked('demo')).toBe(true)
    expect(ok.secretsLocked('demo')).toBe(false)
    expect(locked.secretsLocked('other')).toBe(false)
  })

  it('refuses to change them, keeping the ciphertext exactly as it was', () => {
    const { ok, locked, file } = stores()
    ok.setSecret('demo', 'apiKey', 'sk-1')
    ok.setSecret('demo', '__oauth', '{"refreshToken":"r-1"}')
    const before = readFileSync(file)
    expect(() => locked.setSecret('demo', 'other', 'x')).toThrow(SecretsLockedError)
    expect(() => locked.setSecret('demo', '__oauth', null)).toThrow(SecretsLockedError)
    expect(() => locked.setSecret('demo', 'apiKey', null)).toThrow(SecretsLockedError)
    expect(readFileSync(file).equals(before)).toBe(true)
    // Once it can be read again, everything is still there.
    expect(ok.secrets('demo')).toEqual({ apiKey: 'sk-1', __oauth: '{"refreshToken":"r-1"}' })
  })

  it('treats a file that decrypts to something other than an object as locked too', () => {
    const { ok, file } = stores()
    ok.setSecret('demo', 'apiKey', 'sk-1')
    const odd = new PluginStore(join(file, '..', '..'), { ...working, decrypt: () => '[1]' })
    expect(() => odd.setSecret('demo', 'x', 'y')).toThrow(SecretsLockedError)
  })

  it('deletes them only on an explicit reset', () => {
    const { ok, locked, file } = stores()
    ok.setSecret('demo', 'apiKey', 'sk-1')
    locked.resetSecrets('demo')
    expect(existsSync(file)).toBe(false)
    locked.setSecret('demo', 'apiKey', 'sk-2')
    expect(ok.secrets('demo')).toEqual({ apiKey: 'sk-2' })
  })
})
