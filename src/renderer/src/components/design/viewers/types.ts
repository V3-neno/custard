import type { Artifact, Version } from '../../../../../shared/design'

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
