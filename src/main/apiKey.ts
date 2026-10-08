import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Provider } from '../shared/chat'

// Keys are encrypted with the OS keychain (DPAPI on Windows) and never
// leave the main process. One file per provider.
// The provider name comes from the renderer, so only known names make a path.
function keyPath(provider: Provider): string {
  if (provider === 'claude') return join(app.getPath('userData'), 'api-key.bin')
  if (provider === 'openai') return join(app.getPath('userData'), 'openai-key.bin')
  throw new Error('Unknown provider')
}

export function getApiKey(provider: Provider): string | null {
  if (!existsSync(keyPath(provider))) return null
  try {
    return safeStorage.decryptString(readFileSync(keyPath(provider)))
  } catch {
    return null
  }
}

export function setApiKey(provider: Provider, key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system')
  }
  writeFileSync(keyPath(provider), safeStorage.encryptString(key.trim()))
}

export function clearApiKey(provider: Provider): void {
  rmSync(keyPath(provider), { force: true })
}
