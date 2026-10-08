import { createHash, randomUUID } from 'crypto'
import type {
  Artifact,
  ArtifactFile,
  ArtifactKind,
  MediaFile,
  SkillUse,
  Source,
  Version
} from '../../shared/design'

// Outputs and their versions. Versions are only ever added: a revision or
// variation is a new version, a settled version never changes, and a failed
// or cancelled attempt leaves the last successful one as it was and still
// selected. Every function returns a new Artifact and leaves its input alone.

export class VersionError extends Error {}

// HTML comes from the chat model; images and video only from a media
// provider, so markup can't be recorded as a generated image.
export function checkSource(kind: ArtifactKind, source: Source): void {
  if (kind === 'html' && source.kind !== 'chat-model')
    throw new VersionError('HTML outputs come from the chat model.')
  if (kind !== 'html' && source.kind === 'chat-model')
    throw new VersionError(
      `A ${kind} output must come from a media provider; the chat model can't make one.`
    )
}

type Start = { source: Source; skills: SkillUse[]; now?: number; id?: string }

const version = (
  n: number,
  relation: Version['relation'],
  parent: string | null,
  s: Start
): Version => ({
  id: s.id ?? randomUUID(),
  n,
  relation,
  parent,
  status: 'pending',
  source: s.source,
  skills: s.skills,
  files: [],
  createdAt: s.now ?? Date.now()
})

export function createArtifact(
  a: { conversationId: string; name: string; kind: ArtifactKind; id?: string } & Start
): { artifact: Artifact; version: Version } {
  checkSource(a.kind, a.source)
  const v = version(1, 'first', null, a)
  return {
    artifact: {
      id: a.id ?? randomUUID(),
      conversationId: a.conversationId,
      name: a.name,
      kind: a.kind,
      versions: [v],
      selected: v.id,
      createdAt: v.createdAt
    },
    version: v
  }
}

// A new pending version made from `from` (any settled version, old or new):
// a revision of it, or another option beside it.
export function startVersion(
  artifact: Artifact,
  from: string,
  relation: 'revision' | 'variation',
  s: Start
): { artifact: Artifact; version: Version } {
  checkSource(artifact.kind, s.source)
  const parent = artifact.versions.find((v) => v.id === from)
  if (!parent) throw new VersionError('There is no such version.')
  if (parent.status !== 'succeeded')
    throw new VersionError('Only a finished version can be changed.')
  const v = version(artifact.versions.length + 1, relation, parent.id, s)
  return { artifact: { ...artifact, versions: [...artifact.versions, v] }, version: v }
}

export type Settle =
  { status: 'succeeded'; files: ArtifactFile[] } | { status: 'failed' | 'cancelled'; error: string }

// Ends a pending version. Only a success becomes the selected version.
export function settleVersion(artifact: Artifact, id: string, outcome: Settle): Artifact {
  const v = artifact.versions.find((x) => x.id === id)
  if (!v) throw new VersionError('There is no such version.')
  if (v.status !== 'pending') throw new VersionError('That version is already settled.')
  if (outcome.status === 'succeeded' && !outcome.files.length)
    throw new VersionError('A finished version needs its files.')
  const settled: Version =
    outcome.status === 'succeeded'
      ? { ...v, status: 'succeeded', files: outcome.files }
      : { ...v, status: outcome.status, error: outcome.error }
  return {
    ...artifact,
    versions: artifact.versions.map((x) => (x.id === id ? settled : x)),
    selected: outcome.status === 'succeeded' ? id : artifact.selected
  }
}

export const lastSuccessful = (artifact: Artifact): Version | null =>
  [...artifact.versions].reverse().find((v) => v.status === 'succeeded') ?? null

// How a provider's files are recorded on a version. Storing the bytes is
// the workspace's job (Phase 2); this is what it records.
export const fileRecords = (files: MediaFile[]): ArtifactFile[] =>
  files.map((f) => ({
    path: f.name,
    mime: f.mime,
    sha256: createHash('sha256').update(f.bytes).digest('hex'),
    size: f.bytes.byteLength
  }))
