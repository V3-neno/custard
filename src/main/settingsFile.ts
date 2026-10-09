import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'fs'

// settings.json holds the vault connection, chat model and memory and
// security settings. It is written to a temporary file and renamed, so a
// crash mid-write leaves the last good copy. A file that exists but can't be
// read is moved aside (settings.json.unreadable-<time>) rather than silently
// replaced with defaults on the next save, so nothing in it is destroyed.

export function readSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    // Handled below.
  }
  const aside = `${path}.unreadable-${Date.now()}`
  try {
    renameSync(path, aside)
    console.error(`settings.json couldn't be read; kept as ${aside} and started from defaults.`)
  } catch (err) {
    console.error("settings.json couldn't be read or moved aside", err)
  }
  return {}
}

export function writeSettingsFile(path: string, data: Record<string, unknown>): void {
  const tmp = `${path}.${process.pid}.tmp`
  // Flushed to disk before the rename, so a power cut can't leave the new
  // name pointing at an empty or partial file.
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(data))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}
