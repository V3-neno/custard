import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { writeReplaceSync } from '../fsafe'
import {
  RECORDS_KEPT,
  type AutomationState,
  type RunRecord,
  type RunStatus
} from '../../shared/automations'

// One file per automation in app data (not in the vault): its state and its
// newest run records. Written whole with an atomic replace.
export type RunsFile = { state: AutomationState; runs: RunRecord[] }

const fileOf = (dir: string, id: string): string => join(dir, `${id.replace(/[^\w-]/g, '')}.json`)

export function loadRuns(dir: string, id: string): RunsFile {
  const empty: RunsFile = { state: { failures: 0 }, runs: [] }
  try {
    const raw = JSON.parse(readFileSync(fileOf(dir, id), 'utf8')) as Partial<RunsFile>
    return {
      state: {
        failures: Number(raw.state?.failures) || 0,
        ...(typeof raw.state?.checkedUntil === 'number'
          ? { checkedUntil: raw.state.checkedUntil }
          : {}),
        ...(raw.state?.paused ? { paused: raw.state.paused } : {})
      },
      runs: Array.isArray(raw.runs) ? raw.runs.filter((r) => r && typeof r.id === 'string') : []
    }
  } catch {
    return empty
  }
}

export function saveRuns(dir: string, id: string, f: RunsFile): void {
  mkdirSync(dir, { recursive: true })
  writeReplaceSync(
    fileOf(dir, id),
    JSON.stringify({ state: f.state, runs: f.runs.slice(0, RECORDS_KEPT) })
  )
}

export function deleteRuns(dir: string, id: string): void {
  if (existsSync(fileOf(dir, id))) rmSync(fileOf(dir, id), { force: true })
}

// Newest first.
export function addRun(dir: string, id: string, run: RunRecord): void {
  const f = loadRuns(dir, id)
  f.runs.unshift(run)
  saveRuns(dir, id, f)
}

export function updateRun(
  dir: string,
  id: string,
  runId: string,
  patch: Partial<RunRecord>
): RunRecord | null {
  const f = loadRuns(dir, id)
  const r = f.runs.find((x) => x.id === runId)
  if (!r) return null
  Object.assign(r, patch)
  saveRuns(dir, id, f)
  return r
}

export function updateState(dir: string, id: string, patch: Partial<AutomationState>): void {
  const f = loadRuns(dir, id)
  f.state = { ...f.state, ...patch }
  // An explicit undefined removes a key (resume).
  for (const k of Object.keys(f.state) as (keyof AutomationState)[])
    if (f.state[k] === undefined) delete f.state[k]
  saveRuns(dir, id, f)
}

// A run still marked running when Custard starts was cut off by it closing.
export function closeInterrupted(dir: string, id: string, now: number): number {
  const f = loadRuns(dir, id)
  let n = 0
  for (const r of f.runs)
    if (r.status === 'running') {
      r.status = 'failed' as RunStatus
      r.endedAt = now
      r.reason = 'Custard closed while this was running. What it had already written stays.'
      n++
    }
  if (n) saveRuns(dir, id, f)
  return n
}
