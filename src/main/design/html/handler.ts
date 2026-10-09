import type { Artifact, SkillUse, Version } from '../../../shared/design'
import type { ToolRun } from '../../turn'
import { GUIDANCE_LIMIT, planSkills, skillUse, type Candidate } from '../skills'
import type { DesignService, DesignToolContext, DesignToolHandler } from '../tools'
import { createArtifact, settleVersion, startVersion, VersionError } from '../versions'
import {
  checkAssets,
  HtmlError,
  planFiles,
  type AttachedImage,
  type FileInput,
  type Planned,
  type ReferenceInput
} from './document'

// design_html: one complete HTML document (plus local files) becomes a new
// version of an output. Versions are only added; a failure never touches the
// last good one, which stays selected. Nothing is sent anywhere: HTML comes
// from the chat model that wrote the call. The only checks reported are the
// ones that ran here.

export type PreviewCheck =
  | { loaded: true; ms: number; errors: string[]; blocked: number; missing: string[] }
  | { loaded: false; reason: string; errors: string[] }

export type HtmlDeps = {
  // The vault, when one is set up.
  vault: () => string | null
  // Skills Design lists: vault path and name.
  skills: (vault: string) => { path: string; name: string }[]
  // An attached file of this chat, by id or exact name: image bytes only.
  attachment: (chat: string, idOrName: string) => Promise<AttachedImage>
  // Loads the stored version in a hidden sandboxed preview, when available.
  check?: (chat: string, artifactId: string, versionId: string) => Promise<PreviewCheck>
}

const notRun = (content: string): ToolRun => ({ content, isError: true, outcome: 'not-run' })
const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x : undefined)

type SkillInput = {
  path: string
  strength: Candidate['strength']
  conflicts: string[]
  material?: boolean
  guidance: string
}

function skillInputs(raw: unknown): SkillInput[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((s): SkillInput[] => {
    if (!s || typeof s !== 'object') return []
    const o = s as Record<string, unknown>
    const path = str(o.path)
    if (!path) return []
    // The base schema's `how` maps onto strength.
    const strength =
      o.strength === 'explicit' || o.strength === 'clear' || o.strength === 'similar'
        ? o.strength
        : o.how === 'explicit'
          ? 'explicit'
          : 'clear'
    return [
      {
        path: path.replace(/\\/g, '/').replace(/^\/+/, ''),
        strength,
        conflicts: Array.isArray(o.conflicts)
          ? o.conflicts.filter((c) => typeof c === 'string')
          : [],
        ...(typeof o.material === 'boolean' ? { material: o.material } : {}),
        guidance: typeof o.guidance === 'string' ? o.guidance : ''
      }
    ]
  })
}

// Skills: the model reports what it considered; planSkills decides, the same
// way every time. A question stops generation before anything is stored.
function skillsFor(
  deps: HtmlDeps,
  inputs: SkillInput[]
): { uses: SkillUse[]; notes: string[]; ask: string | null } {
  if (!inputs.length) return { uses: [], notes: [], ask: null }
  const vault = deps.vault()
  const listed = vault ? deps.skills(vault) : []
  const key = (p: string): string => p.toLowerCase()
  const byPath = new Map(listed.map((s) => [key(s.path), s]))
  const candidates: Candidate[] = inputs.map((i) => {
    const s = byPath.get(key(i.path))
    return {
      path: s?.path ?? i.path,
      name: s?.name ?? i.path.split('/').slice(-2, -1)[0] ?? i.path,
      strength: i.strength,
      available: !!s,
      conflicts: i.conflicts.map((c) => byPath.get(key(c))?.path ?? c),
      ...(i.material !== undefined ? { material: i.material } : {})
    }
  })
  const plan = planSkills(candidates)
  if (plan.ask) return { uses: [], notes: plan.notes, ask: plan.ask }
  const uses: SkillUse[] = []
  const notes = [...plan.notes]
  for (const a of plan.apply) {
    const input = inputs.find((i) => key(i.path) === key(a.path))
    try {
      uses.push(
        skillUse(vault!, {
          path: a.path,
          name: a.name,
          how: a.how,
          guidance: (input?.guidance ?? '').slice(0, GUIDANCE_LIMIT)
        })
      )
    } catch {
      notes.push(`"${a.name}" couldn't be read just now, so it isn't recorded as used.`)
    }
  }
  return { uses, notes, ask: null }
}

function inheritedFiles(s: DesignService, chat: string, a: Artifact, parent: Version): Planned[] {
  return parent.files
    .filter((f) => f.path !== 'index.html')
    .map((f) => {
      const bytes = s.artifacts.read(chat, a.id, parent.id, f.path)
      if (!bytes) throw new HtmlError(`${f.path} from version ${parent.n} is missing or changed.`)
      return { path: f.path, mime: f.mime, bytes: new Uint8Array(bytes) }
    })
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export function htmlHandler(deps: HtmlDeps): DesignToolHandler {
  return async (s: DesignService, input: unknown, ctx: DesignToolContext): Promise<ToolRun> => {
    const i = (input ?? {}) as Record<string, unknown>
    const chat = ctx.conversationId
    const html = typeof i.html === 'string' ? i.html : null
    if (html === null)
      return notRun('The complete HTML document is required, so nothing was saved.')

    // The output and the version it starts from.
    const existing = str(i.artifact) ? s.artifacts.get(chat, i.artifact as string) : null
    if (str(i.artifact) && !existing)
      return notRun('There is no such output in this chat, so nothing was saved.')
    if (existing && existing.kind !== 'html')
      return notRun("That output isn't HTML; make a new one instead. Nothing was saved.")
    const parent = existing
      ? existing.versions.find((v) => v.id === (str(i.from) ?? existing.selected))
      : undefined
    if (existing && !parent) return notRun('There is no such version, so nothing was saved.')

    // Skills first: a question means nothing is generated yet.
    const skills = skillsFor(deps, skillInputs(i.skills))
    if (skills.ask)
      return notRun(
        `Ask the user first, then call design_html again: ${skills.ask} Nothing was saved.${skills.notes.length ? ` (${skills.notes.join(' ')})` : ''}`
      )

    // Every file, checked before anything is stored.
    let files: Planned[]
    try {
      const references: { ref: ReferenceInput; image: AttachedImage }[] = []
      for (const r of Array.isArray(i.references) ? i.references : []) {
        const ref = r as ReferenceInput
        if (!ref || typeof ref.attachment !== 'string')
          throw new HtmlError('Each reference needs the attached file.')
        references.push({ ref, image: await deps.attachment(chat, ref.attachment) })
      }
      files = planFiles({
        html,
        files: Array.isArray(i.files) ? (i.files as FileInput[]) : [],
        references,
        inherited:
          existing && parent?.status === 'succeeded'
            ? inheritedFiles(s, chat, existing, parent)
            : []
      })
    } catch (err) {
      return notRun(`${err instanceof Error ? err.message : String(err)} Nothing was saved.`)
    }
    if (ctx.signal.aborted) return notRun('Stopped before it was saved.')

    const source = {
      kind: 'chat-model' as const,
      provider: ctx.chat.provider,
      model: ctx.chat.model
    }
    let artifact: Artifact
    let versionId: string
    try {
      const r = existing
        ? startVersion(
            existing,
            parent!.id,
            i.relation === 'variation' ? 'variation' : 'revision',
            {
              source,
              skills: skills.uses
            }
          )
        : createArtifact({
            conversationId: chat,
            name: (str(i.name) ?? 'Page').trim().slice(0, 60),
            kind: 'html',
            source,
            skills: skills.uses
          })
      artifact = r.artifact
      versionId = r.version.id
    } catch (err) {
      if (err instanceof VersionError) return notRun(`${err.message} Nothing was saved.`)
      throw err
    }

    // Stored once, read-only. A storage failure on an existing output is
    // recorded as a failed version; the last good one stays selected.
    try {
      const records = s.artifacts.writeFiles(chat, artifact.id, versionId, files)
      artifact = settleVersion(artifact, versionId, { status: 'succeeded', files: records })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (!existing)
        return { content: `It couldn't be saved: ${reason}`, isError: true, outcome: 'failed' }
      artifact = settleVersion(artifact, versionId, { status: 'failed', error: reason })
      s.artifacts.save(artifact)
      s.emit({ type: 'artifact', conversationId: chat, artifact })
      const kept = artifact.versions.find((v) => v.id === artifact.selected)
      return {
        content: `It couldn't be saved: ${reason} Version ${kept?.n} is still the one shown.`,
        isError: true,
        outcome: 'failed'
      }
    }
    s.artifacts.save(artifact)
    s.emit({ type: 'artifact', conversationId: chat, artifact })
    const version = artifact.versions.find((v) => v.id === versionId)!

    // Checks that ran, and only those.
    const checks: string[] = []
    const assets = checkAssets(version.files, (p) =>
      Buffer.from(files.find((f) => f.path === p)?.bytes ?? new Uint8Array()).toString('utf8')
    )
    if (assets.local)
      checks.push(
        assets.missing.length
          ? `Local files: ${assets.missing.length} of ${assets.local} referenced are missing (${assets.missing.slice(0, 5).join(', ')}).`
          : `Local files: all ${plural(assets.local, 'reference')} resolve to files in this version.`
      )
    if (assets.external)
      checks.push(
        `${plural(assets.external, 'external reference')} won't load: the preview has no network.`
      )
    if (deps.check) {
      const r = await deps.check(chat, artifact.id, versionId).catch((err): PreviewCheck => ({
        loaded: false,
        reason: String(err?.message ?? err),
        errors: []
      }))
      if (r.loaded) {
        checks.push(`Preview loaded in the sandbox in ${(r.ms / 1000).toFixed(1)} s.`)
        checks.push(
          r.errors.length
            ? `Runtime errors while loading: ${r.errors.slice(0, 5).join(' | ')}`
            : 'No runtime errors while loading.'
        )
        if (r.blocked) checks.push(`${plural(r.blocked, 'request')} to outside the page blocked.`)
        if (r.missing.length)
          checks.push(`Not found while loading: ${r.missing.slice(0, 5).join(', ')}.`)
      } else {
        checks.push(`The preview didn't load: ${r.reason}`)
        if (r.errors.length) checks.push(`Runtime errors: ${r.errors.slice(0, 5).join(' | ')}`)
      }
    }
    const what =
      version.relation === 'first'
        ? `Saved "${artifact.name}" (output ${artifact.id}), version 1 (${versionId}).`
        : `Saved version ${version.n} of "${artifact.name}" (output ${artifact.id}, version ${versionId}), a ${version.relation} of version ${existing!.versions.find((v) => v.id === version.parent)?.n}.`
    return {
      content: [
        what,
        `It is shown in the workspace with ${plural(version.files.length, 'file')}.`,
        checks.length ? `Checks run: ${checks.join(' ')}` : 'No checks ran.',
        skills.notes.length ? `Skills: ${skills.notes.join(' ')}` : 'No skills applied.',
        "Tell the user only the checks listed here; don't claim others."
      ].join('\n'),
      isError: false,
      outcome: 'completed'
    }
  }
}
