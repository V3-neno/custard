// Running in the background (docs/automations.md, "Running in the
// background"): whether Custard stays in the tray when its window is closed,
// starts at login, notifies about runs, and the limits on all automations
// together. Stored in settings.json under `background`.

export type BackgroundSettings = {
  // Closing the window hides it; Custard keeps running in the tray.
  keepInTray: boolean
  // Start at login, hidden in the tray. Only with keepInTray: without a tray
  // there would be no way to see or quit it.
  openAtLogin: boolean
  // OS notifications when a run fails, stops at a limit, pauses itself, is
  // skipped at a limit, or leaves a question.
  notify: boolean
  // Scheduled runs a day, all automations together (Run now not counted).
  runsPerDayAll: number
  // Skip scheduled runs once this month's estimated spend reaches the
  // budget under Spending. Does nothing without a budget.
  stopAtBudget: boolean
}

export const DEFAULT_BACKGROUND: BackgroundSettings = {
  keepInTray: false,
  openAtLogin: false,
  notify: true,
  runsPerDayAll: 48,
  stopAtBudget: true
}

export const RUNS_PER_DAY_ALL: [number, number] = [1, 200]

// What Settings shows: the settings, and whether this system can start
// Custard at login (Electron supports it on Windows and macOS only).
export type BackgroundView = { settings: BackgroundSettings; loginSupported: boolean }

export function normalizeBackground(raw: unknown): BackgroundSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const n = r.runsPerDayAll
  const keepInTray = bool(r.keepInTray, DEFAULT_BACKGROUND.keepInTray)
  return {
    keepInTray,
    openAtLogin: keepInTray && bool(r.openAtLogin, DEFAULT_BACKGROUND.openAtLogin),
    notify: bool(r.notify, DEFAULT_BACKGROUND.notify),
    runsPerDayAll:
      typeof n === 'number' && Number.isInteger(n)
        ? Math.min(RUNS_PER_DAY_ALL[1], Math.max(RUNS_PER_DAY_ALL[0], n))
        : DEFAULT_BACKGROUND.runsPerDayAll,
    stopAtBudget: bool(r.stopAtBudget, DEFAULT_BACKGROUND.stopAtBudget)
  }
}
