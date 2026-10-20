import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { BrowserWindow } from 'electron'
import {
  checkAutomation,
  MAX_AUTOMATIONS,
  type Automation,
  type AutomationView,
  type RunContext
} from '../../shared/automations'
import { handle } from '../ipc'
import {
  automationQuestionsFile,
  automationRunsDir,
  getAutomations,
  getBackground,
  getVaultGrants,
  getVaultPath,
  setAutomations,
  usageThisMonth,
  vaultEditsDir
} from '../store'
import { refreshTray, reportRun, setTrayState } from '../background'
import type { TrayState } from '../trayMenu'
import { gateReason } from './gate'
import { localDay } from './schedule'
import { extensionRefusal, extensionTarget } from '../modes/extensions'
import { pluginHost, protectedRoots } from '../plugins'
import { stepFor } from './model'
import { deleteRuns, loadRuns, updateState } from './records'
import { addQuestion, closeQuestion, deleteQuestionsOf, loadQuestions } from './questions'
import { runAutomation, type RunDeps } from './run'
import { Scheduler, type RunResult } from './scheduler'

let scheduler: Scheduler | null = null

function deps(a: Automation): RunDeps {
  const vault = getVaultPath()
  const root = vault && existsSync(vault) ? vault : null
  return {
    vault: root,
    grants: getVaultGrants(),
    recordsDir: vaultEditsDir(),
    // Like Chat: skills, plugin files and Custard's own files stay protected.
    guard: (real) => {
      const t = root ? extensionTarget(real, root, protectedRoots()) : null
      return t ? extensionRefusal(t, 'Automation') : null
    },
    pluginTools: (ids) => pluginHost().readToolSet(ids),
    callPlugin: async (name, input, signal, snapshot) => {
      // `data` is for widgets only.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { data, ...r } = await pluginHost().invoke(name, input, {
        snapshot: snapshot as ReturnType<typeof pluginHost.prototype.toolSet>['snapshot'],
        signal,
        mode: 'chat',
        caller: 'automation',
        // Nobody is there to ask: a read tool that wants approval is declined.
        approve: async () => false
      })
      return r
    },
    describePlugin: (name, input) => pluginHost().describeCall(name, input)?.label ?? null,
    step: stepFor,
    leaveQuestion: (runId, slot, q) => {
      return addQuestion(
        automationQuestionsFile(),
        { automationId: a.id, automationName: a.name, runId, ...(slot ? { slot } : {}) },
        q
      )
    },
    now: () => Date.now()
  }
}

async function runOne(
  a: Automation,
  slot: string | undefined,
  signal: AbortSignal,
  ctx: RunContext,
  runId: string
): Promise<RunResult> {
  const limit = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    limit.abort()
  }, a.limits.minutes * 60_000)
  const onAbort = (): void => limit.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const r = await runAutomation(a, slot, limit.signal, deps(a), ctx, runId)
    return timedOut
      ? { ...r, status: 'stopped', reason: `Stopped at the limit of ${a.limits.minutes} minutes.` }
      : r
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

const notify = (): void => {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send('automations:changed')
  refreshTray()
}

// Scheduled runs started today (the computer's day) by all automations.
function runsToday(now: number): number {
  const today = localDay(now)
  return getAutomations().reduce(
    (n, a) =>
      n +
      loadRuns(automationRunsDir(), a.id).runs.filter(
        (r) => r.kind === 'scheduled' && r.status !== 'skipped' && localDay(r.startedAt) === today
      ).length,
    0
  )
}

// What the tray icon's menu says.
function trayState(): TrayState {
  const all = getAutomations()
  let last: TrayState['last'] = null
  const paused: string[] = []
  for (const a of all) {
    const f = loadRuns(automationRunsDir(), a.id)
    if (f.state.paused) paused.push(a.name)
    const r = f.runs.find((x) => x.status !== 'running' && x.endedAt)
    if (r?.endedAt && (!last || r.endedAt > last.at))
      last = { name: a.name, status: r.status, at: r.endedAt }
  }
  return {
    running: all.find((a) => scheduler?.running(a.id))?.name ?? null,
    on: all.filter((a) => a.enabled).length,
    paused,
    last
  }
}

export function startAutomations(): void {
  if (scheduler) return
  scheduler = new Scheduler({
    dir: automationRunsDir(),
    now: () => Date.now(),
    list: getAutomations,
    run: runOne,
    changed: notify,
    gate: () => gateReason(getBackground(), runsToday(Date.now()), usageThisMonth()),
    report: reportRun
  })
  setTrayState(trayState)
  scheduler.start()
}

// Whether an automation is running now (Reload of the models file waits).
export const automationRunning = (): boolean => scheduler?.busy() ?? false

export function stopAutomations(): void {
  scheduler?.stop()
  scheduler = null
}

const views = (): AutomationView[] =>
  getAutomations().map((automation) => {
    const f = loadRuns(automationRunsDir(), automation.id)
    return {
      automation,
      state: f.state,
      running: scheduler?.running(automation.id) ?? false,
      runs: f.runs.slice(0, 30)
    }
  })

export function registerAutomationHandlers(): void {
  handle('automations:list', () => views())
  handle('automations:save', (_, raw: unknown) => {
    const input = { ...((raw ?? {}) as Record<string, unknown>) }
    const all = getAutomations()
    const isNew = typeof input.id !== 'string' || !input.id
    if (isNew) input.id = `a-${randomUUID().slice(0, 8)}`
    const c = checkAutomation(input)
    if (!c.ok) return { ok: false as const, problem: c.problem }
    if (isNew && all.length >= MAX_AUTOMATIONS)
      return { ok: false as const, problem: `At most ${MAX_AUTOMATIONS} automations.` }
    if (!isNew && !all.some((a) => a.id === c.automation.id))
      return { ok: false as const, problem: 'That automation no longer exists.' }
    // Only folders the user has allowed can be given to an automation.
    const granted = new Set(getVaultGrants().map((g) => g.folder.toLowerCase()))
    const missing = c.automation.folders.filter((f) => !granted.has(f.toLowerCase()))
    if (missing.length)
      return {
        ok: false as const,
        problem: `Allow ${missing.join(', ')} under Editable folders first.`
      }
    setAutomations(
      isNew ? [...all, c.automation] : all.map((a) => (a.id === c.automation.id ? c.automation : a))
    )
    if (isNew) updateState(automationRunsDir(), c.automation.id, { checkedUntil: Date.now() })
    notify()
    return { ok: true as const, id: c.automation.id }
  })
  handle('automations:delete', (_, id: string) => {
    setAutomations(getAutomations().filter((a) => a.id !== id))
    deleteRuns(automationRunsDir(), String(id))
    deleteQuestionsOf(automationQuestionsFile(), String(id))
    notify()
  })
  handle('automations:setEnabled', (_, id: string, enabled: boolean) => {
    setAutomations(getAutomations().map((a) => (a.id === id ? { ...a, enabled: !!enabled } : a)))
    // Turning it on again also clears an automatic pause, and starts looking
    // for slots from now.
    if (enabled) scheduler?.resume(String(id))
    notify()
  })
  handle('automations:resume', (_, id: string) => {
    scheduler?.resume(String(id))
    notify()
  })
  handle('automations:questions', () =>
    loadQuestions(automationQuestionsFile()).sort((a, b) => b.created - a.created)
  )
  handle('automations:dismissQuestion', (_, id: string) => {
    closeQuestion(automationQuestionsFile(), String(id), { status: 'dismissed' })
    notify()
  })
  handle('automations:runNow', (_, id: string) => scheduler?.runNow(String(id)) ?? false)
}
