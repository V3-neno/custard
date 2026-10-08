import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { app } from 'electron'
import { join } from 'path'
import type { Workspace } from '../../shared/plugins'
import { custardSource, pluginDocsDir, pluginHost, pluginsRoot, sdkDir } from '../plugins'
import type { Boundary } from './paths'
import {
  FILE_WRITES,
  fileTools,
  previewFileChange,
  referenceTools,
  runFileTool,
  runReferenceTool,
  type FilePreview
} from './tools'

type Result = { content: string; isError: boolean }

export type WorkspaceTools = {
  tools: BetaTool[]
  prompt: string
  has: (name: string) => boolean
  run: (name: string, input: unknown, signal?: AbortSignal) => Promise<Result>
  // File changes need the user's approval of exactly this preview first.
  // Throws (a PathError) when the change would be refused anyway.
  preview: (name: string, input: unknown) => FilePreview | null
}

const previewer =
  (b: Boundary) =>
  (name: string, input: unknown): FilePreview | null =>
    FILE_WRITES.has(name) ? previewFileChange(b, name, input) : null

const devTools: BetaTool[] = [
  {
    name: 'plugin_validate',
    description:
      "Validate this plugin: checks plugin.json, API compatibility, input and config schemas and tool names, then builds it into a staged build. Doesn't activate anything.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'plugin_test',
    description:
      "Run this plugin's tests (tests/*.test.ts) and a load check in a sandbox with no network. Doesn't activate anything.",
    input_schema: { type: 'object', properties: {} }
  }
]

function internal(pluginId: string): WorkspaceTools {
  const boundary: Boundary = {
    root: join(pluginsRoot(), pluginId),
    deny: [app.getPath('userData')]
  }
  const refs: Record<string, string> = { docs: pluginDocsDir(), sdk: sdkDir() }
  if (pluginId !== 'spotify') refs['examples/spotify'] = join(pluginsRoot(), 'spotify')
  const names = new Set([...fileTools, ...referenceTools, ...devTools].map((t) => t.name))
  return {
    tools: [...fileTools, ...referenceTools, ...devTools],
    has: (n) => names.has(n),
    preview: previewer(boundary),
    prompt: [
      `Workspace: Internal (Plugins). You are developing the Custard plugin "${pluginId}". The fs_ tools work only inside plugin/${pluginId}; everything else, including Custard's core, is out of reach.`,
      '- Read the reference first: reference_read docs/API.md and docs/MANIFEST.md, and look at examples/spotify for a complete plugin. sdk/ is the custard-plugin-sdk source.',
      '- Work in steps: edit, then plugin_validate, then plugin_test, and fix what they report. Show the user what you changed and which permissions the plugin asks for.',
      "- You can't activate, enable or install plugins, and you have no shell. When it validates and tests cleanly, tell the user to open Settings → Plugins, review the changes and permissions, and activate it.",
      '- Plugin code runs in a sandbox with no Node.js and no direct network. Everything goes through the context: ctx.fetch (https, hosts in permissions.network), ctx.storage, ctx.openExternal, ctx.config. There are no npm packages.',
      "- If the plugin needs something the SDK doesn't offer, say so plainly and describe the core change it would need as a separate proposal. Don't try to work around the sandbox.",
      '- Each file change you make is shown to the user in full and happens only if they allow it; a declined change did nothing.',
      '- Mark every tool that changes something outside Custard as effect "write"; Custard asks the user before each call. Never put secrets in files; secret settings are config fields with secret: true.'
    ].join('\n'),
    run: async (name, input, signal) => {
      if (name.startsWith('fs_')) return runFileTool(boundary, name, input)
      if (name.startsWith('reference_')) return runReferenceTool(refs, name, input)
      if (name === 'plugin_validate') {
        const v = await pluginHost().validate(pluginId)
        const lines = [
          v.ok
            ? `Valid. Build ${v.buildId} of version ${v.manifest?.version} is staged.`
            : 'Validation failed:',
          ...v.errors.map((e) => `- ${e}`),
          ...v.warnings.map((w) => `- warning: ${w}`),
          v.ok ? 'Run plugin_test next. Only the user can activate it, in Settings → Plugins.' : ''
        ]
        return { content: lines.filter(Boolean).join('\n'), isError: !v.ok }
      }
      if (name === 'plugin_test') {
        const r = await pluginHost().test(pluginId, signal)
        const lines = [
          r.ok ? 'All checks passed.' : 'Some checks failed.',
          ...r.results.map(
            (t) => `- ${t.ok ? 'pass' : 'FAIL'}: ${t.name}${t.error ? ` (${t.error})` : ''}`
          ),
          r.error ? `Error: ${r.error}` : ''
        ]
        return { content: lines.filter(Boolean).join('\n'), isError: !r.ok }
      }
      return { content: `Unknown tool ${name}`, isError: true }
    }
  }
}

function general(root: string, coreAccess: boolean): WorkspaceTools {
  const deny = [app.getPath('userData')]
  if (!coreAccess) deny.push(custardSource(), pluginsRoot(), sdkDir())
  const boundary: Boundary = { root, deny }
  const names = new Set(fileTools.map((t) => t.name))
  return {
    tools: fileTools,
    has: (n) => names.has(n),
    preview: previewer(boundary),
    prompt: [
      `Workspace: General Code, in the folder ${root}. The fs_ tools read and edit files only inside it.`,
      coreAccess
        ? "The user explicitly allowed editing Custard's own source in this conversation. Be careful: changes there affect the app itself."
        : "Custard's own source is protected here even if it is inside this folder.",
      "You have no shell, so you can't run builds, tests, installs or scripts. Give the user the exact commands to run themselves.",
      'Read files before changing them, keep edits focused, and list every file you created, changed, renamed or deleted. The user sees each change in full and allows it before it happens; a declined change did nothing.'
    ].join('\n'),
    run: async (name, input) => runFileTool(boundary, name, input)
  }
}

export function workspaceTools(w: Workspace | undefined): WorkspaceTools | null {
  if (!w) return null
  return w.kind === 'internal' ? internal(w.pluginId) : general(w.root, w.coreAccess === true)
}
