import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { Provider } from '../shared/chat'

// L12: the provider name comes from the renderer and becomes part of a file
// name, so anything but a known provider is refused.

const base = mkdtempSync(join(tmpdir(), 'custard-keys-'))
const userData = join(base, 'userData')
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

const { clearApiKey, getApiKey, setApiKey } = await import('./apiKey')

describe('stored API keys', () => {
  it('keeps one file per known provider', () => {
    mkdirSync(userData, { recursive: true })
    setApiKey('claude', ' sk-a ')
    setApiKey('openai', 'sk-o')
    expect(getApiKey('claude')).toBe('sk-a')
    expect(getApiKey('openai')).toBe('sk-o')
    clearApiKey('openai')
    expect(getApiKey('openai')).toBeNull()
  })

  it('refuses a provider name that is not a known provider', () => {
    const bad = '../escaped' as Provider
    expect(() => setApiKey(bad, 'sk-x')).toThrow(/Unknown provider/)
    expect(() => clearApiKey(bad)).toThrow(/Unknown provider/)
    expect(() => getApiKey(bad)).toThrow(/Unknown provider/)
    expect(existsSync(join(base, 'escaped-key.bin'))).toBe(false)
    expect(readdirSync(base).sort()).toEqual(['userData'])
  })
})
