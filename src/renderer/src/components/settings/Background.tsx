import { useEffect, useState } from 'react'
import {
  RUNS_PER_DAY_ALL,
  type BackgroundSettings,
  type BackgroundView
} from '../../../../shared/background'
import { cleanError, input } from './ui'

// Running in the background: the tray, start at login, notifications, and
// the limits on all automations together. Part of Automations.
export default function Background(): React.JSX.Element | null {
  const [view, setView] = useState<BackgroundView | null>(null)
  const [runs, setRuns] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.custard.background.get().then((v) => {
      setView(v)
      setRuns(String(v.settings.runsPerDayAll))
    })
  }, [])
  if (!view) return null
  const s = view.settings

  const save = async (patch: Partial<BackgroundSettings>): Promise<void> => {
    setError(null)
    try {
      const v = await window.custard.background.set({ ...s, ...patch })
      setView(v)
      setRuns(String(v.settings.runsPerDayAll))
    } catch (e) {
      setError(cleanError(e))
    }
  }
  const saveRuns = (): void => {
    const n = Number(runs)
    const [lo, hi] = RUNS_PER_DAY_ALL
    if (!Number.isInteger(n) || n < lo || n > hi) {
      setError(`Runs a day for all automations must be a whole number from ${lo} to ${hi}.`)
      return
    }
    if (n !== s.runsPerDayAll) void save({ runsPerDayAll: n })
  }

  const box = (
    label: string,
    key: 'keepInTray' | 'openAtLogin' | 'notify' | 'stopAtBudget',
    text: React.ReactNode,
    disabled = false
  ): React.JSX.Element => (
    <label className="flex items-start gap-2 text-sm text-ash-300">
      <input
        type="checkbox"
        className="mt-1"
        aria-label={label}
        checked={s[key]}
        disabled={disabled}
        onChange={(e) =>
          void save(
            key === 'keepInTray' && !e.target.checked
              ? { keepInTray: false, openAtLogin: false }
              : { [key]: e.target.checked }
          )
        }
      />
      <span className={disabled ? 'text-ash-500' : ''}>{text}</span>
    </label>
  )

  return (
    <div
      className="mb-3 space-y-2 rounded-lg border border-forge-700 bg-forge-900 p-3"
      data-background
    >
      <h4 className="text-xs font-medium text-ash-300">Running in the background</h4>
      {box(
        'Keep running in the tray',
        'keepInTray',
        <>
          Keep Custard running in the tray when you close its window, so automations keep to their
          schedule. The tray icon shows a dot while a run is going and lists the last run; quit
          Custard from its menu.
        </>
      )}
      {box(
        'Start at login',
        'openAtLogin',
        view.loginSupported ? (
          <>Start Custard when you log in, hidden in the tray.</>
        ) : (
          <>
            Start Custard when you log in, hidden in the tray. Only in the installed app on Windows
            or macOS.
          </>
        ),
        !view.loginSupported || !s.keepInTray
      )}
      {box(
        'Notify me about runs',
        'notify',
        <>
          Notify me when a run fails, stops at one of its limits, pauses itself, is skipped at a
          limit, or leaves a question. The notification names the automation only; the details stay
          in its runs below.
        </>
      )}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ash-300">Runs a day, all automations together</p>
          <p className="text-xs text-ash-500">
            Scheduled runs started today; more are skipped. {RUNS_PER_DAY_ALL[0]} to{' '}
            {RUNS_PER_DAY_ALL[1]}.
          </p>
        </div>
        <input
          aria-label="Runs a day for all automations"
          type="number"
          min={RUNS_PER_DAY_ALL[0]}
          max={RUNS_PER_DAY_ALL[1]}
          value={runs}
          onChange={(e) => setRuns(e.target.value)}
          onBlur={saveRuns}
          onKeyDown={(e) => e.key === 'Enter' && saveRuns()}
          className={`${input} !w-20 !py-1`}
        />
      </div>
      {box(
        'Skip runs past the budget',
        'stopAtBudget',
        <>
          Skip scheduled runs once this month&apos;s estimated spend reaches your budget under
          Spending. Without a budget this does nothing.
        </>
      )}
      <p className="text-xs text-ash-500">
        Run now isn&apos;t counted against runs a day or stopped by the budget: you are there. Each
        automation also has its own limits, set when you edit it.
      </p>
      {error && <p className="text-sm text-ember-600">{error}</p>}
    </div>
  )
}
