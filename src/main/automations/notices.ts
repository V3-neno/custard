import type { SchedulerReport } from './scheduler'

// What an OS notification says about a run. Only the automation's name (the
// user wrote it) and Custard's own words: never the run's reason, summary or
// question, which can carry text a run read from notes or plugins.

export type Notice = { title: string; body: string }

const WHERE = 'Details in Settings → Automations.'

export function noticeFor(e: SchedulerReport): Notice | null {
  const name = e.automation.name
  if (e.type === 'skipped') {
    // A missed slot is caught up or noted in the record; not worth a ping.
    if (e.cause === 'missed') return null
    return {
      title: 'Automation skipped',
      body:
        e.cause === 'limit'
          ? `${name} was skipped: it reached its limit of runs a day. ${WHERE}`
          : // The gate's reason is Custard's own text (index.ts, gateReason).
            `${name} was skipped. ${e.reason}`
    }
  }
  if (e.paused)
    return {
      title: 'Automation paused',
      body: `${name} failed ${e.automation.limits.failuresBeforePause} times in a row and paused itself. ${WHERE}`
    }
  if (e.status === 'failed') return { title: 'Automation failed', body: `${name} failed. ${WHERE}` }
  if (e.status === 'stopped')
    return {
      title: 'Automation stopped',
      body: `${name} was stopped at one of its limits. ${WHERE}`
    }
  if (e.questions > 0)
    return {
      title: 'Automation has a question',
      body: `${name} left a question for you. Claude asks it in your next chat.`
    }
  return null
}

// Skips repeat every slot once a limit is reached; one notice a day for each
// automation and cause is enough. Failures are always told.
export class NoticeGate {
  private seen = new Set<string>()

  constructor(private readonly day: () => string) {}

  pass(e: SchedulerReport): boolean {
    if (e.type !== 'skipped') return true
    const key = `${this.day()}|${e.automation.id}|${e.cause}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}
