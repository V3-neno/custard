import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

// The key is encrypted with the OS keychain (DPAPI on Windows) and never
// leaves the main process.
const keyPath = (): string => join(app.getPath('userData'), 'api-key.bin')

export function getApiKey(): string | null {
  if (!existsSync(keyPath())) return null
  try {
    return safeStorage.decryptString(readFileSync(keyPath()))
  } catch {
    return null
  }
}

export function setApiKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system')
  }
  writeFileSync(keyPath(), safeStorage.encryptString(key.trim()))
}

export function clearApiKey(): void {
  rmSync(keyPath(), { force: true })
}
