import type { FileChange } from '../../shared/plugins'
import type { SourceFile } from './build'

// A small line diff for the review screen: changed lines with two lines of
// context. Very large files are listed as changed without a diff.

const MAX_CELLS = 4_000_000

function lineDiff(a: string[], b: string[]): string | undefined {
  if (a.length * b.length > MAX_CELLS) return undefined
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const ops: { t: ' ' | '-' | '+'; s: string }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i++] })
      j++
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push({ t: '+', s: b[j++] })
    else ops.push({ t: '-', s: a[i++] })
  }
  const keep = ops.map(
    (o, k) => o.t !== ' ' || ops.slice(Math.max(0, k - 2), k + 3).some((x) => x.t !== ' ')
  )
  const out: string[] = []
  ops.forEach((o, k) => {
    if (keep[k]) out.push(`${o.t} ${o.s}`)
    else if (keep[k - 1]) out.push('…')
  })
  return out.join('\n')
}

export function diffSources(before: SourceFile[], after: SourceFile[]): FileChange[] {
  const old = new Map(before.map((f) => [f.path, f.content]))
  const now = new Map(after.map((f) => [f.path, f.content]))
  const changes: FileChange[] = []
  for (const [path, content] of now) {
    const prev = old.get(path)
    if (prev === undefined)
      changes.push({ path, change: 'added', diff: lineDiff([], content.split('\n')) })
    else if (prev !== content)
      changes.push({
        path,
        change: 'changed',
        diff: lineDiff(prev.split('\n'), content.split('\n'))
      })
  }
  for (const path of old.keys()) if (!now.has(path)) changes.push({ path, change: 'removed' })
  return changes.sort((x, y) => x.path.localeCompare(y.path))
}
