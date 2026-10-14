import type { TestReport } from '../../shared/plugins'

const REPORT_LINES = 80
const ERROR_CHARS = 400

// Failures first and in full (cut at ERROR_CHARS with a marker), then passes
// with their times; a long list is cut with a count, never silently.
export function testReport(r: TestReport): string {
  const ran = r.ran ?? r.results.length
  const head = r.error
    ? r.ok
      ? 'Tests passed.'
      : 'Tests did not finish cleanly.'
    : ran === 0
      ? 'No tests ran. Add tests in tests/*.test.ts; nothing was checked.'
      : r.ok
        ? `All ${ran} checks passed.`
        : `${r.results.filter((t) => !t.ok).length} of ${ran} checks failed.`
  const time = (t: { ms?: number }): string => (t.ms === undefined ? '' : ` [${t.ms} ms]`)
  const cut = (e: string): string =>
    e.length > ERROR_CHARS
      ? `${e.slice(0, ERROR_CHARS)}[… ${e.length - ERROR_CHARS} more characters left out …]`
      : e
  const rows = [...r.results.filter((t) => !t.ok), ...r.results.filter((t) => t.ok)].map(
    (t) => `- ${t.ok ? 'pass' : 'FAIL'}: ${t.name}${time(t)}${t.error ? ` (${cut(t.error)})` : ''}`
  )
  const shown = rows.slice(0, REPORT_LINES)
  return [
    head,
    ...shown,
    rows.length > shown.length ? `[… ${rows.length - shown.length} more results left out …]` : '',
    r.skipped ? `${r.skipped} tests did not match the filter and were skipped.` : '',
    r.error ? `Error: ${r.error}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}
