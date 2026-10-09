import { beforeEach, describe, expect, it, vi } from 'vitest'

// The app's IPC answers only the app window: a plugin sandbox, a widget view
// or a Design preview calling a channel (say, Design's job cancel) is
// refused before the handler runs.

const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, f: (e: unknown, ...a: unknown[]) => unknown) => handlers.set(c, f),
    on: () => {}
  }
}))
const plugin = { id: 1 }
const widget = { id: 2 }
const preview = { id: 3 }
const app = { id: 4 }
vi.mock('./plugins/runtime', () => ({ isPluginContents: (wc: unknown) => wc === plugin }))
vi.mock('./widgets/surface', () => ({ isWidgetContents: (wc: unknown) => wc === widget }))

describe('IPC sender checks', () => {
  beforeEach(() => handlers.clear())

  it('refuses plugin, widget and preview contents on every channel', async () => {
    const { handle, refuseContents } = await import('./ipc')
    refuseContents((wc) => wc === preview)
    const ran: unknown[] = []
    handle('design:job', (_e, ...a) => ran.push(a))
    const call = (sender: unknown): unknown =>
      handlers.get('design:job')!({ sender }, 'chat', 'cancel', 'job')
    for (const sender of [plugin, widget, preview])
      expect(() => call(sender)).toThrow('Not allowed')
    expect(ran).toEqual([])
    call(app)
    expect(ran).toEqual([['chat', 'cancel', 'job']])
  })
})
