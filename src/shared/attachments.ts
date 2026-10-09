import type { Provider } from './chat'

// Files attached to a chat message (see main/attachments). The bytes live in
// Custard's app data; a chat keeps only these records.

export type AttachmentKind = 'image' | 'pdf' | 'text'

export type Attachment = {
  // Random; also the stored file's name (with `ext`). Never from the user.
  id: string
  // The user message (index in the chat's messages) it was sent with.
  message: number
  // The file's own name, for display only.
  name: string
  kind: AttachmentKind
  mime: string
  ext: string
  bytes: number
  sha256: string
  width?: number
  height?: number
  // Animated GIF: the number of frames.
  frames?: number
  pages?: number
  chars?: number
  // Providers that received it: set once a request carrying it was accepted.
  sentTo?: Provider[]
  // Custard's copy was found missing or changed, so it is no longer sent.
  missing?: boolean
}

// A file in the composer, checked and copied but not sent yet.
export type DraftAttachment = Omit<Attachment, 'message'> & { draft: string }

export type AttachResult =
  { ok: true; attachment: DraftAttachment } | { ok: false; name: string; error: string }

// Modes whose messages can carry files: Chat, and Design for references.
export const attachmentModes: readonly string[] = ['chat', 'design']
export const acceptsAttachments = (mode: string): boolean => attachmentModes.includes(mode)

export const ATTACHMENT_LIMITS = {
  imageBytes: 5_000_000,
  imageSide: 8000,
  pdfBytes: 20_000_000,
  pdfPages: 100,
  textBytes: 500_000,
  textChars: 200_000,
  perMessage: 10,
  messageBytes: 20_000_000,
  // Base64 of every file in one request, under Claude's 32 MB request limit.
  requestBase64: 28_000_000,
  // A GIF frame walk stops here.
  gifFrames: 10_000
}

// Text and code files, by extension. Content must still be valid UTF-8.
export const TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'ps1',
  'sql',
  'lua',
  'r',
  'ini',
  'cfg',
  'conf',
  'log',
  'env',
  'gitignore',
  'dockerfile'
]

export const kindLabel: Record<AttachmentKind, string> = {
  image: 'Image',
  pdf: 'PDF',
  text: 'Text'
}

// What memory capture and the handoff summarizer may know about a message's
// files: how many and of which types. Never names or contents.
export function filesNote(files: Pick<Attachment, 'kind'>[]): string {
  if (!files.length) return ''
  const names: Record<AttachmentKind, [string, string]> = {
    image: ['image', 'images'],
    pdf: ['PDF', 'PDFs'],
    text: ['text file', 'text files']
  }
  const kinds = (['image', 'pdf', 'text'] as AttachmentKind[])
    .map((k) => [k, files.filter((f) => f.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${names[k][n === 1 ? 0 : 1]}`)
  return `[${files.length} ${files.length === 1 ? 'file' : 'files'} attached (${kinds.join(', ')}); names and contents not shown]`
}

export const formatBytes = (n: number): string =>
  n < 1000
    ? `${n} B`
    : n < 1_000_000
      ? `${Math.round(n / 1000)} KB`
      : `${(n / 1_000_000).toFixed(1)} MB`
