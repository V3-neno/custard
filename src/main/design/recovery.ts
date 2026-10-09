import type { MediaFile } from '../../shared/design'

// Local-only restart recovery (stabilization contract S2).
//
// On restart Custard may reconcile its own durable records: a built-in
// provider that saved a result locally before the job recorded it (a crash
// in between) can say so, and the job is linked to it. This interface is for
// Custard's own storage only. It is never offered to plugins, makes no
// network request, invokes no plugin tool and never resubmits anything.
// Remote status checks stay in the user-started check and track flow.
//
// `correlationId` is Custard's local job id (Job.id), recorded with the
// result when it was saved. It is not a provider idempotency guarantee.

export interface LocalResultIndex {
  // The built-in provider whose local store this is.
  readonly providerId: string
  // A locally saved result for this job, if one exists and still validates
  // (type and size checked as when it was saved).
  find(correlationId: string): { remoteId: string } | null
  // Its files, read from local storage only.
  read(remoteId: string): MediaFile[] | null
}

const indexes = new Map<string, LocalResultIndex>()

// Built-in code only (registered at startup by the provider's own module).
export function registerLocalResults(index: LocalResultIndex): void {
  indexes.set(index.providerId, index)
}

export const localResults = (providerId: string): LocalResultIndex | null =>
  indexes.get(providerId) ?? null

// For tests.
export const clearLocalResults = (): void => indexes.clear()
