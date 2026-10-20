import type { BackgroundSettings } from '../../shared/background'
import type { UsageMonth } from '../../shared/chat'
import { formatCost } from '../../shared/pricing'

// The limits on all automations together (Settings → Automations, "Running
// in the background"): the reason to skip a scheduled run, or null. Run now
// is never gated; the user is there.
export function gateReason(
  s: Pick<BackgroundSettings, 'runsPerDayAll' | 'stopAtBudget'>,
  runsToday: number,
  month: Pick<UsageMonth, 'cost' | 'budget'>
): string | null {
  if (runsToday >= s.runsPerDayAll)
    return `All automations together reached the limit of ${s.runsPerDayAll} scheduled runs a day.`
  if (s.stopAtBudget && month.budget !== null && month.cost >= month.budget)
    return `This month's estimated spend (${formatCost(month.cost)}) reached your budget (${formatCost(month.budget)}). Scheduled runs are skipped until next month or a higher budget.`
  return null
}
