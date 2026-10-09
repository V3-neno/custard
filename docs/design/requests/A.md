# Workstream A: requests for shared files

Changes A needs in integration-owned files. A's code already handles each
one; until it lands, A's e2e drives the missing pieces directly.

## A1. Let a handler bring its own schema (`src/main/design/tools.ts`)

`design_html` needs fields the base schema doesn't have (text asset files,
attachment references, skill candidates). Smallest change: an optional
schema on registration, used in place of the base entry.

```ts
const schemas = new Map<DesignToolName, BetaTool>()
export const setDesignToolHandler = (name: DesignToolName, h: DesignToolHandler, schema?: BetaTool): void => {
  handlers.set(name, h)
  if (schema) schemas.set(name, schema)
}
export const designTools = (): BetaTool[] =>
  designToolSchemas
    .filter((t) => handlers.has(t.name as DesignToolName))
    .map((t) => schemas.get(t.name as DesignToolName) ?? t)
```

A then passes `htmlSchema` from `src/main/design/html/schema.ts`.

## A2. Preload (`src/preload/index.ts`, under `design`)

```ts
// The HTML of a version's index.html, for the Code view (text only, ≤ 2 MB).
source: (chat: string, artifactId: string, versionId: string): Promise<string | null> =>
  ipcRenderer.invoke('design:source', chat, artifactId, versionId),
// Whether the skills behind a version changed since (see main/design/skills).
skillChanges: (chat: string, artifactId: string, versionId: string): Promise<SkillChange[]> =>
  ipcRenderer.invoke('design:skills', chat, artifactId, versionId),
```

`SkillChange` is `{ path: string; name: string; state: 'same' | 'changed' | 'missing' }`
(today in `src/main/design/skills.ts`; moving the type to `src/shared/design.ts`
would let the preload import it). The preview state pushed on
`design:preview:state` is `PreviewState` from `src/main/design/html/preview.ts`;
`onState` can stay `unknown` or import that type.

A registers both channels in `registerHtml()`.

## A3. IPC refusal (`src/main/ipc.ts`)

The preview has no preload, so it can't reach `ipcRenderer`. As with
widgets, refuse it anyway:

```ts
import { isPreviewContents } from './design/html/preview'
const refused = (wc) => isPreviewContents(wc) || isPluginContents(wc) || isWidgetContents(wc)
```

## A4. Design prompt (`src/main/chat.ts`, `MODE_PROMPTS.design`)

The prompt still says to give HTML in fenced code blocks. With `design_html`
offered it should say:

> When the user wants a page, mockup or UI, make it with design_html: send
> the complete document (inline CSS and JS, or local files through `files`),
> never a fragment, and never only a code block. Change an output by sending
> a new complete version with `artifact` (and `from` for an older one);
> `relation: "variation"` for another option beside it. Before generating,
> read any skill whose description fits and list each one you considered in
> `skills` with its strength (explicit when the user named it, clear, or
> similar); if design_html answers with a question, ask the user that
> question and stop. The user's own words override skill defaults. Report
> only the checks design_html says ran.

## A5. Attachment ids visible to the model (`src/main/attachments/request.ts` or `chat.ts`)

`design_media` and `design_html` take attachment ids, but the model never
sees one: the file blocks carry only the name. Either add the id to the label
text in Design (`[Attached file "logo.png", id 3f…]`), or accept names.
A's handler accepts an id or an exact file name, so this only matters for
`design_media`.
