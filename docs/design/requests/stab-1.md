# Stabilization Thread 1: edits outside Thread 1's files

For the integration owner. Thread 1 made these edits on its branch because
they are the agreed shared interfaces (plan §3, items 1 to 4) or the
callers they force. Each is small; take, change or redo them as you see fit.

| File | Owner | Change | Why |
| --- | --- | --- | --- |
| `src/shared/design.ts` | integration | `MediaError.confirmed` (4th arg, default false); `MediaReference.sha256?`; `SubmissionApproval`; `Job.approval?`; `MediaProvider.submit` options `jobId?`, `approval?`; `cancel(remoteId, { jobId })` may resolve `'unknown'` | Interfaces 1, 3, 4 |
| `src/main/design/approval.ts` (new) | integration (shared by jobs/tools/host) | Approval digest, `approveSubmission`, `approvalMismatch` | Interface 3 |
| `src/main/design/jobs.ts` | integration (catch: Thread 1) | `create`/`resubmitJob` take `approval`; `submit` refuses a missing or mismatched approval before `attemptedAt` (failed, not sent); `submit` passes `jobId`/`approval`; catch uses `confirmed`; `cancel` passes `{ jobId }` and handles `'unknown'` | 1.3, 1.4, 1.2 |
| `src/main/design/tools.ts` | integration (cancel path/approval wrapper: Thread 1) | `media()` records the approval before the card; Custard's own refusal is `not-run`, not "<provider> refused it"; `design_jobs cancel` shows its own card; `jobAction` takes `cancelApproved`; stop-tracking text | 1.2, 1.3 |
| `src/main/chat.ts` | integration (mode/approval code: Thread 1) | `designReferences` carries the attachment's `sha256`; `design_jobs` with `action: cancel` counts as a write | 1.3, 1.2 |
| `src/main/design/index.ts` | integration | IPC `design:job` passes `cancelApproved` for the workspace's confirmed cancel | 1.2 |
| `src/main/design/images/openai.ts` | Thread 3 | Local refusals before sending (lines ~170–201) are `confirmed`. **HTTP 4xx left unconfirmed (now outcome unknown) for Thread 3 to decide from OpenAI's docs.** | Interface 1 |
| `src/main/design/images/openai.test.ts`, `test/e2e/design-images.mjs` | Thread 3 | A 400 now expects `unknown`, with a note pointing at Thread 3 | Follows from the above |
| `src/renderer/.../viewers/VideoViewer.tsx` | Thread 3 | "Cancel job" takes a confirming second click; stop-tracking tooltip says it may be charged | 1.2 (the controls live here, not in Workspace.tsx) |
| `test/fixtures/media/slow-video.ts`, `src/main/design/design.test.ts`, `tools.test.ts` | integration | Tests attach approvals; providers' own pre-send refusals are `confirmed` | Follows from the interfaces |

## Finding for the integration owner (not fixed here)

`tools.ts media()`: if `jobs.submit()` throws a `JobError` (for example the
provider turned not-ready between the card and the send, via `need()`), the
error escapes `runDesignTool`, and the version created for the job stays
`pending` with the job `not-submitted`. Nothing is sent, so it's not a charge
risk, but the output is left hanging. Reproduce: disable the plugin inside
the approval callback (see the removed draft in Thread 1's notes).
