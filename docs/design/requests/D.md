# Workstream D: requests for shared files

## D1. Plugin links: scheme allowlist, actions only (approved by Neno, 2026-10-09)

Neno chose "Allowlist" on the D1 card (see `docs/design/SECURITY-REVIEW.md`).
Patch: `D1-open-allowlist.patch` in this folder, made against `design-batch`
at 2b11675. `git apply --check` passes there.

What it changes:

- `src/main/plugins/manifest.ts`: `VETTED_SCHEMES = new Set(['spotify'])`.
  `validOpenPrefix` accepts an `https://host/` prefix (unchanged) or a bare
  custom scheme only if it's on that set. `BLOCKED_SCHEMES` stays as it is
  (it still guards https-only rules and documents intent).
- `src/main/plugins/host.ts`: each running call records `write`.
  `capability('openExternal')` refuses unless the call is a write tool
  ("Only actions can open links, so nothing was opened.").
- `host.test.ts` and `manifest.test.ts`: the fixture's `demo:` scheme becomes
  `spotify:`, and the fixture's `open` tool becomes a write tool with
  `action:open` granted. No assertions change otherwise.

Checked locally with the patch applied: `tsc` (node) clean;
`vitest run src/main/plugins` gives 143 passed, plus D's own security tests,
which D flips after the patch lands (they assert the old behaviour today).
The Spotify plugin (`spotify:`, `open` is a write tool) is unaffected.

Docs to update with it (suggested wording):

- `docs/plugins/MANIFEST.md`, `permissions.openExternal`: "Link prefixes the
  plugin may open: an https prefix ending in `/`, or a custom scheme Custard
  has vetted (today only `spotify:`). Any other scheme is a manifest error.
  Only write tools (actions) can open links."
- `docs/plugins/SECURITY.md`, "Custom-scheme links": "Only schemes on
  Custard's vetted list can be declared, because any app can register a
  scheme and some handlers write files or start tools. Approving one still
  means trusting that app's handler."

Existing user plugins that declare another scheme will fail validation on
their next review. Today only Spotify declares one.
