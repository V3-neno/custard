import type { Artifact, Job, Version } from '../../../../../shared/design'

// What the workspace (Workstream A) gives each kind's viewer. Image viewer:
// Workstream B. Video viewer: Workstream C. HTML viewer: Workstream A.
export type ViewerProps = {
  chat: string
  artifact: Artifact
  version: Version
}

// A stored file of a version, for <img> and <video> in the app window.
export const mediaUrl = (
  chat: string,
  artifactId: string,
  versionId: string,
  path: string
): string =>
  `custard-media://${chat}/${artifactId}/${versionId}/${path.split('/').map(encodeURIComponent).join('/')}`

// The job that fills a version. Found by the job's target: Design doesn't
// record the job's id on the version (Version.jobId is never set), so
// looking it up by that id finds nothing.
export const jobOf = (jobs: Job[], artifactId: string, versionId: string): Job | undefined =>
  jobs.find((j) => j.target.artifactId === artifactId && j.target.versionId === versionId)
