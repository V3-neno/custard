# Thread 3 requests to the integration owner

Stabilization thread 3 (provider evidence and integrated UI), branch
`claude/project-thread-jvsxq9`.

## R1: show media viewers for versions that aren't finished (Workspace.tsx)

**Found by** `test/e2e/design-image-workspace.mjs`, last check.

`Workspace.tsx` renders the viewer only when the selected version
`succeeded`; otherwise it shows "Not ready yet." / "This version failed.".
So `VideoViewer`'s job panel (state, progress, **Check now**, **Cancel job**,
**Stop tracking**) and `ImageViewer`'s pending and failed messages are never
shown in the real workspace. A plugin video still in progress can't be
checked, cancelled or stopped from the pane at all.

Proposed patch (keeps HTML as it is; media viewers already handle every
status). Verified: with it, the workspace test passes 27/27, including the
pending-video check.

```diff
--- a/src/renderer/src/components/design/Workspace.tsx
+++ b/src/renderer/src/components/design/Workspace.tsx
@@ -202,7 +202,7 @@ export default function Workspace({
       )}
 
       <div className="flex min-h-0 flex-1 flex-col">
-        {selected.status !== 'succeeded' ? (
+        {selected.status !== 'succeeded' && artifact.kind === 'html' ? (
           <p className="m-auto text-sm text-ash-500">
             {selected.status === 'pending'
               ? 'Not ready yet.'
```

**Ordering with Thread 1:** this makes the workspace **Cancel job** button
reachable. Thread 1's explicit-intent confirmation (S3, "Thread 1 adds the
visible confirmation in `Workspace.tsx`") should land in the same
integration step, so a one-click cancel is never exposed. The button lives
in `VideoViewer.tsx` (`JobPanel`), which Thread 3 owns; Thread 1 is welcome
to edit it there, or tell me and I'll add the confirmation.

A pending *revision* still can't be viewed (its version button is disabled
and the selection stays on the last good one). Not changed here; the newest
pending version could get a job line under the version buttons later.

## R2 (FYI): `Version.jobId` is never set

`src/shared/design.ts` declares `Version.jobId?`, but nothing in
`src/main` sets it, so viewers that looked up the job by it found nothing:
the image viewer said "Change to v1" instead of "Change to v1: an edit of an
attached image", and the video job panel had no job. Thread 3 fixed the
viewers to find the job by `job.target` (`viewers/types.ts` `jobOf`). Either
set `jobId` when the job is created, or remove the field so nobody relies on
it again. No change needed for Thread 3's code either way.

## R3 (FYI): edits outside the plan's §3 list

Both small and needed for 3.2 / 3.1 consistency; say if you'd rather take
them yourself:

- `src/main/design/capabilities.ts` `limitsOf`: the Design settings line now
  reads "pricing, not a quote: …" (was "Price: …"), matching the card. The
  file isn't assigned to any thread.
- `test/e2e/design-images.mjs` (workstream B's test): the card regex follows
  the new rate wording.

## Withdrawn

- The earlier `MediaError.confirmed` request is replaced by contract S1;
  `openai.ts` now sets `dispatch` directly.
