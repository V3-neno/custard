import { existsSync, lstatSync, readdirSync, realpathSync } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'

// Where extensions live, so modes that only use them can't write there by
// any route: a note path, a folder link inside the vault that leads into the
// skills folder, different letter case, or Windows' trailing dots and
// spaces. Used for model-chosen write targets (vault notes today; artifact
// export later).
//
// Limitation, as for every path check here: it runs just before the write,
// so another program swapping a folder for a link in between (a race) isn't
// prevented.

export const SKILLS_DIR = 'Custard/Skills'

// Custard's own files ('app') are protected the same way.
export type ExtensionKind = 'skill' | 'plugin' | 'app'

export type ProtectedRoots = { plugin: string[]; app: string[] }

// Windows and macOS compare names without case, and Windows drops trailing
// dots and spaces, so "custard/skills./x" is the skills folder there. The
// check is that strict everywhere: refusing an odd name on Linux costs nothing.
const norm = (p: string): string =>
  resolve(p)
    .split(sep)
    .map((s, i) => (i === 0 ? s : s.replace(/[. ]+$/, '')))
    .join(sep)
    .toLowerCase()

const inside = (child: string, parent: string): boolean => {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

// Whether a write to `full` lands inside `root`, by the path as written and
// by where it really lands (links resolved).
export function writesInside(full: string, root: string): boolean {
  return inside(full, root) && inside(realTarget(full), realTarget(root))
}

// Whether the real path is one of root's parent folders: creating a note
// walks through them (vault makeDirs checks each one), and they are only
// passed through, never written.
export function aboveRoot(real: string, root: string): boolean {
  const r = realTarget(root)
  return inside(r, real) && norm(r) !== norm(real)
}

// The real location a path would have: the deepest part that exists, with
// its links resolved, plus the parts that don't exist yet.
export function realTarget(p: string): string {
  let cur = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      lstatSync(cur)
      return join(realpathSync.native(cur), ...rest)
    } catch {
      const up = dirname(cur)
      if (up === cur) return join(cur, ...rest)
      rest.unshift(basename(cur))
      cur = up
    }
  }
}

// Every real folder whose contents Custard would load as skills: the skills
// folder itself (wherever a link takes it) and anything linked from inside it.
function skillRoots(vault: string): string[] {
  const dir = join(vault, SKILLS_DIR)
  const roots = [dir, realTarget(dir)]
  if (existsSync(dir))
    try {
      for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isSymbolicLink()) roots.push(realTarget(join(dir, e.name)))
    } catch {
      // An unreadable folder loads no skills.
    }
  return roots
}

// What kind of extension a write to `full` (an absolute path in the vault)
// would create or change, or null for an ordinary location.
export function extensionTarget(
  full: string,
  vault: string,
  roots: ProtectedRoots
): ExtensionKind | null {
  const real = realTarget(full)
  // By name, as written, and by where it really lands.
  if (inside(full, join(vault, SKILLS_DIR))) return 'skill'
  if (skillRoots(vault).some((r) => inside(real, r))) return 'skill'
  const under = (root: string): boolean =>
    inside(full, root) || inside(real, root) || inside(real, realTarget(root))
  if (roots.plugin.some(under)) return 'plugin'
  if (roots.app.some(under)) return 'app'
  return null
}

export function extensionRefusal(kind: ExtensionKind, modeLabel: string): string {
  if (kind === 'skill')
    return `${modeLabel} mode can't create or change skills, so nothing was done. Skills are made in Skills mode; you can draft the skill's text here for the user to copy.`
  if (kind === 'plugin')
    return `${modeLabel} mode can't write plugin files, so nothing was done. Plugins are built in Plugins mode; you can draft a development prompt here for the user to copy.`
  return "That path is inside Custard's own files, which notes can't be written to, so nothing was done."
}
