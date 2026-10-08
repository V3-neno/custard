// A whole-file line diff for approval previews: every line of the new file
// appears, prefixed "+ " (added), "- " (removed) or "  " (unchanged), so
// nothing that will be written is left out of what the user approves.

const MAX_CELLS = 4_000_000

export function lineDiff(before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > MAX_CELLS)
    return [
      `(Too large to compare line by line: the current file has ${a.length} lines. Every line of the new content follows.)`,
      ...b.map((l) => `+ ${l}`)
    ].join('\n')
  // Longest common subsequence, filled from the end.
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${a[i++]}`)
    else out.push(`+ ${b[j++]}`)
  }
  while (i < n) out.push(`- ${a[i++]}`)
  while (j < m) out.push(`+ ${b[j++]}`)
  return out.join('\n')
}
