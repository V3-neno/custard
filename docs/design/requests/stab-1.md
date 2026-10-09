# Stabilization Thread 1: requests and notes for the integration owner

Thread 1 works on the published contracts (ce41cd5). Its own files: host.ts,
manifest.ts, plugin-media/*, MODE-BOUNDARY.md, MEDIA-PLUGINS.md, MANIFEST.md,
the D2 section of SECURITY-REVIEW.

## Edits outside Thread 1's files

| File                                       | Owner       | Change                                                                                                                                                                                                                                                               | Why                                                                                           |
| ------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/main/design/authorization.ts`         | integration | `consume(token, actual, unseen?)`: fields the caller can't establish from what it sends (`conversationId`; for a cancel also `jobId` and `references`) are taken from the binding, after the job tracker's `check()` covered them. The token is still deleted first. | The plugin host consumes at dispatch but doesn't know the chat, nor a cancel's job and files. |
| `src/renderer/.../viewers/VideoViewer.tsx` | Thread 3    | "Cancel job" takes a confirming second click; stop-tracking tooltip says it may be charged.                                                                                                                                                                          | The workspace cancel control lives here, not in Workspace.tsx.                                |
| `src/main/ipc.security.test.ts` (new)      | —           | Plugin, widget and preview senders are refused on `design:job`.                                                                                                                                                                                                      | Amendment 3 test: unauthorized renderers.                                                     |
| `test/e2e/design-media.mjs`                | Thread 1    | Cancel shows its own card; a plugin's "not sent" stays unknown.                                                                                                                                                                                                      |                                                                                               |

## Notes

- `chat.ts`: `design_jobs` with `action: cancel` still counts as a read in
  `CORE_WRITES` (so its outcome isn't tracked as an action). Suggest
  `design_jobs` cancel be treated as a write there.
- `tools.ts` stop text could say the job "may be charged" (brief 1.2).
- `MediaProvider.cancel` returns only `cancelled`/`not-cancelled`; a cut-off
  cancel is reported as "did not confirm", which is accurate but not
  "unknown". Optional: add `'unknown'`.
- `host.invoke`'s `preApproved` remains for the chat's own "repeat an
  unknown action" card on ordinary plugin tools (the user just approved
  that exact call on a card). It can't reach media tools. Replacing it with a
  token too is possible; say if you want it.
- Finding (not fixed): if `jobs.submit()` throws a `JobError` (the provider
  turned not-ready between the card and the send, via `need()`), the error
  escapes `runDesignTool` and the new version stays `pending`. Nothing is
  sent.
