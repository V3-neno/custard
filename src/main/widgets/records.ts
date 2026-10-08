import { app } from 'electron'
import { join } from 'path'
import { readSettingsFile, writeSettingsFile } from '../settingsFile'
import type { WidgetRecord } from './manager'

// Which widget each conversation shows (or had closed), in widgets.json in
// the app's data folder. Kept apart from the conversation files so a widget
// change never races a turn's saves. Only the widget's identity, its input
// from the assistant, and its size are kept: never anything the widget
// loaded.

const path = (): string => join(app.getPath('userData'), 'widgets.json')
let cache: Record<string, WidgetRecord> | null = null

const load = (): Record<string, WidgetRecord> =>
  (cache ??= readSettingsFile(path()) as Record<string, WidgetRecord>)

export const widgetRecords = {
  get(id: string): WidgetRecord {
    const r = load()[id]
    return r && typeof r === 'object' ? r : {}
  },
  set(id: string, r: WidgetRecord): void {
    const all = load()
    if (!r.active && !r.dismissed) delete all[id]
    else all[id] = r
    try {
      writeSettingsFile(path(), all)
    } catch (err) {
      console.error("widgets.json couldn't be saved", err)
    }
  }
}
