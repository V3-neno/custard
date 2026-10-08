import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import {
  isDeniedName,
  isInside,
  PathError,
  resolveInside,
  splitRelative,
  toRelative,
  type Boundary
} from './paths'
import { lineDiff } from './diff'

// File tools for Code mode. They only ever touch paths inside the
// conversation's workspace, resolved by resolveInside. There is no shell:
// in the Plugins workspace, building and testing go through host operations
// that never run plugin code outside its sandbox.

const MAX_READ = 200_000
const MAX_WRITE = 500_000
const MAX_LIST = 500
const MAX_SCAN = 5_000

const pathProp = (d: string): Record<string, unknown> => ({ type: 'string', description: d })

export const fileTools: BetaTool[] = [
  {
    name: 'fs_list',
    description: 'List files and folders in a workspace folder. Folders end with "/".',
    input_schema: {
      type: 'object',
      properties: { path: pathProp('Folder relative to the workspace root. Omit for the root.') }
    }
  },
  {
    name: 'fs_read',
    description: 'Read a text file in the workspace.',
    input_schema: {
      type: 'object',
      properties: { path: pathProp('File path relative to the workspace root') },
      required: ['path']
    }
  },
  {
    name: 'fs_search',
    description:
      'Find files in the workspace whose path or text contains the query (case-insensitive). Returns up to 30 matches with a matching line.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  },
  {
    name: 'fs_write',
    description:
      'Create or replace a text file in the workspace with the full new content. Missing folders are created.',
    input_schema: {
      type: 'object',
      properties: {
        path: pathProp('File path relative to the workspace root'),
        content: { type: 'string', description: 'The complete file content' }
      },
      required: ['path', 'content']
    },
    eager_input_streaming: true
  },
  {
    name: 'fs_delete',
    description: 'Delete one file in the workspace (not folders).',
    input_schema: {
      type: 'object',
      properties: { path: pathProp('File path relative to the workspace root') },
      required: ['path']
    }
  },
  {
    name: 'fs_rename',
    description: 'Rename or move a file inside the workspace. Fails if the target exists.',
    input_schema: {
      type: 'object',
      properties: { from: pathProp('Current path'), to: pathProp('New path') },
      required: ['from', 'to']
    }
  }
]

export const isFileTool = (name: string): boolean => name.startsWith('fs_')

type Result = { content: string; isError: boolean }
const ok = (content: string): Result => ({ content, isError: false })

function list(b: Boundary, path: unknown): string {
  const dir = resolveInside(b, path ?? '', { mustExist: true })
  if (!statSync(dir).isDirectory()) throw new PathError('Not a folder.')
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !isDeniedName(e.name))
    .map((e) =>
      e.isDirectory()
        ? `${e.name}/`
        : e.isSymbolicLink()
          ? `${e.name} (link, not followed)`
          : e.name
    )
    .sort()
  if (!entries.length) return '(empty folder)'
  return entries.length > MAX_LIST
    ? `${entries.slice(0, MAX_LIST).join('\n')}\n[${entries.length - MAX_LIST} more not shown]`
    : entries.join('\n')
}

function read(b: Boundary, path: unknown): string {
  const full = resolveInside(b, path, { mustExist: true })
  if (!lstatSync(full).isFile()) throw new PathError('Not a file.')
  const buf = readFileSync(full)
  if (buf.subarray(0, 8000).includes(0)) throw new PathError('That looks like a binary file.')
  const text = buf.toString('utf8')
  return text.length > MAX_READ
    ? `${text.slice(0, MAX_READ)}\n[truncated at ${MAX_READ} characters]`
    : text
}

function* walk(b: Boundary, dir: string, budget = { left: MAX_SCAN }): Generator<string> {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (budget.left <= 0 || isDeniedName(e.name) || e.isSymbolicLink()) continue
    const full = join(dir, e.name)
    if ((b.deny ?? []).some((d) => isInside(full, d))) continue
    if (e.isDirectory()) yield* walk(b, full, budget)
    else if (e.isFile()) {
      budget.left--
      yield full
    }
  }
}

function search(b: Boundary, query: unknown): string {
  if (typeof query !== 'string' || !query.trim()) throw new PathError('A query is required.')
  const q = query.toLowerCase()
  const root = resolveInside(b, '', { mustExist: true })
  const hits: string[] = []
  for (const f of walk(b, root)) {
    const rel = toRelative(b.root, f)
    let line = ''
    try {
      const buf = readFileSync(f)
      if (buf.length < 1_000_000 && !buf.subarray(0, 8000).includes(0))
        line =
          buf
            .toString('utf8')
            .split('\n')
            .find((l) => l.toLowerCase().includes(q))
            ?.trim()
            .slice(0, 160) ?? ''
    } catch {
      continue
    }
    if (line || rel.toLowerCase().includes(q)) hits.push(`- ${rel}${line ? `: ${line}` : ''}`)
    if (hits.length >= 30) break
  }
  return hits.length ? hits.join('\n') : 'No files matched.'
}

function mkdirs(b: Boundary, rel: string): void {
  // One folder at a time, each re-checked, so a link can't be slipped in.
  const parts = splitRelative(rel).slice(0, -1)
  for (let i = 1; i <= parts.length; i++) {
    const dir = resolveInside(b, parts.slice(0, i).join('/'), { forWrite: true })
    if (!existsSync(dir)) mkdirSync(dir)
  }
}

function write(b: Boundary, path: unknown, content: unknown): string {
  if (typeof content !== 'string') throw new PathError('Content is required.')
  if (content.length > MAX_WRITE) throw new PathError('Files are limited to 500 KB.')
  const rel = String(path ?? '')
  if (!splitRelative(rel).length) throw new PathError('A file path is required.')
  mkdirs(b, rel)
  const full = resolveInside(b, rel, { forWrite: true })
  const existed = existsSync(full)
  if (existed && !lstatSync(full).isFile()) throw new PathError('Not a file.')
  writeFileSync(full, content)
  return `${existed ? 'Updated' : 'Created'} ${toRelative(b.root, full)}`
}

function remove(b: Boundary, path: unknown): string {
  const full = resolveInside(b, path, { forWrite: true, mustExist: true })
  if (!splitRelative(path).length || !lstatSync(full).isFile())
    throw new PathError('Only files can be deleted.')
  rmSync(full)
  return `Deleted ${toRelative(b.root, full)}`
}

function rename(b: Boundary, from: unknown, to: unknown): string {
  const src = resolveInside(b, from, { forWrite: true, mustExist: true })
  if (!lstatSync(src).isFile()) throw new PathError('Only files can be renamed.')
  const rel = String(to ?? '')
  if (!splitRelative(rel).length) throw new PathError('A new path is required.')
  const dst = resolveInside(b, rel, { forWrite: true })
  if (existsSync(dst)) throw new PathError('Something already exists at the new path.')
  mkdirs(b, rel)
  renameSync(src, resolveInside(b, rel, { forWrite: true }))
  return `Renamed ${toRelative(b.root, src)} to ${rel}`
}

export const FILE_WRITES = new Set(['fs_write', 'fs_delete', 'fs_rename'])

export type FilePreview = { label: string; detail: string }

// What a file change will do, for the user to approve before it runs. It
// resolves paths with the same checks as the change itself, so a path that
// would be refused is refused here, without asking. `detail` holds the whole
// change: for a write, every line of the new content.
export function previewFileChange(b: Boundary, name: string, input: unknown): FilePreview {
  const i = (input ?? {}) as Record<string, unknown>
  if (name === 'fs_write') {
    if (typeof i.content !== 'string') throw new PathError('Content is required.')
    if (i.content.length > MAX_WRITE) throw new PathError('Files are limited to 500 KB.')
    const rel = String(i.path ?? '')
    if (!splitRelative(rel).length) throw new PathError('A file path is required.')
    const full = resolveInside(b, rel, { forWrite: true })
    const shown = splitRelative(rel).join('/')
    if (!existsSync(full))
      return {
        label: `Create ${shown}`,
        detail: `New file ${shown}, ${i.content.length} characters:\n\n${i.content}`
      }
    if (!lstatSync(full).isFile()) throw new PathError('Not a file.')
    const before = readFileSync(full)
    const old = before.subarray(0, 8000).includes(0) ? null : before.toString('utf8')
    return {
      label: `Replace ${shown}`,
      detail:
        old === null
          ? `Replaces a binary file with ${i.content.length} characters of text:\n\n${i.content}`
          : `Changes to ${shown} (+ added, - removed):\n\n${lineDiff(old, i.content)}`
    }
  }
  if (name === 'fs_delete') {
    const full = resolveInside(b, i.path, { forWrite: true, mustExist: true })
    if (!lstatSync(full).isFile()) throw new PathError('Only files can be deleted.')
    const shown = toRelative(b.root, full)
    return { label: `Delete ${shown}`, detail: `Deletes ${shown} (${statSync(full).size} bytes).` }
  }
  if (name === 'fs_rename') {
    const src = resolveInside(b, i.from, { forWrite: true, mustExist: true })
    if (!lstatSync(src).isFile()) throw new PathError('Only files can be renamed.')
    const rel = String(i.to ?? '')
    if (!splitRelative(rel).length) throw new PathError('A new path is required.')
    resolveInside(b, rel, { forWrite: true })
    const from = toRelative(b.root, src)
    const to = splitRelative(rel).join('/')
    return { label: `Rename ${from} to ${to}`, detail: `Moves ${from} to ${to}.` }
  }
  throw new PathError(`${name} doesn't change files.`)
}

export function runFileTool(b: Boundary, name: string, input: unknown): Result {
  const i = (input ?? {}) as Record<string, unknown>
  try {
    switch (name) {
      case 'fs_list':
        return ok(list(b, i.path))
      case 'fs_read':
        return ok(read(b, i.path))
      case 'fs_search':
        return ok(search(b, i.query))
      case 'fs_write':
        return ok(write(b, i.path, i.content))
      case 'fs_delete':
        return ok(remove(b, i.path))
      case 'fs_rename':
        return ok(rename(b, i.from, i.to))
      default:
        return { content: `Unknown tool ${name}`, isError: true }
    }
  } catch (err) {
    return {
      content:
        err instanceof PathError
          ? err.message
          : `File operation failed: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      isError: true
    }
  }
}

// Read-only reference material for plugin development: the docs, the SDK and
// example plugins, each under a fixed virtual folder.
export const referenceTools: BetaTool[] = [
  {
    name: 'reference_list',
    description:
      'List read-only plugin reference material. Top level: docs/ (plugin API and manifest docs), sdk/ (the custard-plugin-sdk source), examples/ (example plugins).',
    input_schema: {
      type: 'object',
      properties: { path: pathProp('e.g. "docs" or "examples/spotify"') }
    }
  },
  {
    name: 'reference_read',
    description: 'Read a file from the plugin reference material, e.g. "docs/API.md".',
    input_schema: {
      type: 'object',
      properties: { path: pathProp('e.g. "docs/API.md"') },
      required: ['path']
    }
  }
]

export function runReferenceTool(
  roots: Record<string, string>,
  name: string,
  input: unknown
): Result {
  const i = (input ?? {}) as Record<string, unknown>
  try {
    const parts = splitRelative(i.path ?? '')
    if (!parts.length) {
      if (name === 'reference_list')
        return ok(
          Object.keys(roots)
            .map((k) => `${k}/`)
            .join('\n')
        )
      throw new PathError('A path is required.')
    }
    const top = parts[0] === 'examples' ? parts.slice(0, 2).join('/') : parts[0]
    const root = roots[top]
    if (parts[0] === 'examples' && parts.length === 1 && name === 'reference_list')
      return ok(
        Object.keys(roots)
          .filter((k) => k.startsWith('examples/'))
          .map((k) => `${k.slice(9)}/`)
          .join('\n')
      )
    if (!root) throw new PathError('Not found in the reference material.')
    const rest = parts.slice(top.split('/').length).join('/')
    const b = { root }
    return name === 'reference_list' ? ok(list(b, rest)) : ok(read(b, rest))
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true }
  }
}
