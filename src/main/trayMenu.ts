// What the tray icon says (background.ts draws it). Kept free of Electron so
// it can be tested.

export type TrayState = {
  // The automation running now, if any.
  running: string | null
  // Automations turned on, and those paused (by themselves or the user).
  on: number
  paused: string[]
  // The newest run that ended.
  last: { name: string; status: string; at: number } | null
}

export type TrayItem =
  { kind: 'info'; label: string } | { kind: 'separator' } | { kind: 'open' | 'quit'; label: string }

const STATUS: Record<string, string> = {
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped at a limit',
  skipped: 'skipped'
}

const time = (t: number): string =>
  new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function trayTooltip(s: TrayState): string {
  return s.running ? `Custard · running ${s.running}` : 'Custard'
}

export function trayMenu(s: TrayState): TrayItem[] {
  const items: TrayItem[] = [
    {
      kind: 'info',
      label: s.running
        ? `Running now: ${s.running}`
        : s.on
          ? `${s.on === 1 ? '1 automation' : `${s.on} automations`} on, none running`
          : 'No automations on'
    }
  ]
  if (s.last)
    items.push({
      kind: 'info',
      label: `Last run: ${s.last.name}, ${STATUS[s.last.status] ?? s.last.status} at ${time(s.last.at)}`
    })
  for (const p of s.paused.slice(0, 3)) items.push({ kind: 'info', label: `Paused: ${p}` })
  if (s.paused.length > 3)
    items.push({ kind: 'info', label: `and ${s.paused.length - 3} more paused` })
  items.push(
    { kind: 'separator' },
    { kind: 'open', label: 'Open Custard' },
    { kind: 'quit', label: 'Quit Custard' }
  )
  return items
}

// The running dot: an amber disc with a dark ring in the bottom-right
// quarter of a square BGRA bitmap (Electron's nativeImage.toBitmap order).
// Returns a new buffer.
export function withDot(bgra: Uint8Array, size: number): Uint8Array {
  const out = Uint8Array.from(bgra)
  const r = size * 0.22
  const ring = Math.max(1, size * 0.06)
  const c = size - r - ring
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      if (d > r + ring) continue
      const i = (y * size + x) * 4
      // Molten #F5AE3F inside, forge #110C08 ring; B, G, R, A.
      const [b, g, rr] = d <= r ? [0x3f, 0xae, 0xf5] : [0x08, 0x0c, 0x11]
      out[i] = b
      out[i + 1] = g
      out[i + 2] = rr
      out[i + 3] = 255
    }
  return out
}
