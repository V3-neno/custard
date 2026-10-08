# History-based Back: blocked under the strict requested contract

Investigation: 2026-10-07. **This is a blocker report and design handoff, not an implemented Back feature.** Version 1.2.1 changes intent-routing instructions and the native Previous tool description only. It deliberately adds no nonfunctional Back tool, replay endpoint, history collector, cursor, OAuth scope, or storage permission.

## Inspected

- Plugin API and manifest development references; SDK v1 source.
- `src/index.ts`, `src/client.ts`, `src/tools.ts`, `src/playback.ts`, existing tests, manifest, instructions and playback handoff.
- `examples/spotify` was requested but is unavailable in the reference material.
- No plugin-owned widget exists. SDK v1 explicitly has no UI, subscriptions, account-change callback, or background work. No host API was invented and no core files were changed.
- Current controls preflight the active device, preserve approval, distinguish rejected/unknown/accepted writes, and keep native Previous separate from seek-to-zero. Those implementations remain unchanged.

The user-reported TV/API sequences Marbella → Heartbreaker → native Previous → REA and Toxic → Min Bitch → native Previous → REA were subsequently reproduced by the user in Spotify itself. They are background evidence, not new live verification and not classified here as plugin bugs.

## Exact history blocker

The API data available to this plugin does not establish the immediately preceding listening occurrence in all the cases the requested contract includes. Consider two possible real playback sequences:

1. A → B
2. A → X (briefly heard and skipped between foreground reads) → B

Both can produce the same foreground observations A, B and the same lagging recent-history response containing A. The correct Back target is A in the first case and X in the second. No cursor, deduplication algorithm, short freshness threshold, successful Next response, or reconciliation heuristic can distinguish those identical inputs. Selecting A silently would violate the requirement not to substitute an older known song for the actual predecessor.

Even a pre-Next snapshot and a post-Next snapshot do not provide an atomic transition log: Spotify warns that Player endpoint execution order is not guaranteed, and external controllers can intervene. A very short time threshold is a heuristic, not proof of no intervening briefly heard tracks. An equal URI after a gap could be the same occurrence, a restart, repeat, or A → X → A.

This does **not** mean useful observed-history navigation is impossible. It means that a best-effort observed-history feature must be described as such, or an uncertain candidate must be confirmed by the user. Neither is silently equivalent to the strict actual-listening-history contract. No such relaxed behavior is implemented in this revision.

## Recently played investigation

[Spotify Get Recently Played Tracks](https://developer.spotify.com/documentation/web-api/reference/get-recently-played) exposes `GET /v1/me/player/recently-played`:

- Requires `user-read-recently-played`. Default limit 20, maximum 50 per request; exclusive `before` or `after` millisecond cursor, not both. Podcast episodes are not supported.
- Entries include a track, `played_at`, and context. `played_at` is a reported play timestamp, not a unique occurrence identifier or an acknowledged transition sequence number.
- The retrieved contract supplies no freshness SLA, completeness guarantee for briefly played/skipped tracks, or definitive minimum-listening-duration threshold. Do not assume a 30-second rule.
- Do not infer immediate adjacency from array position, consecutive timestamps, or newest-result equality with the current URI. Chronological sorting can normalize the *reported* timestamps; it cannot repair missing events, ties or incorrect timestamps.
- [Historical timestamp inconsistency report](https://github.com/spotify/web-api/issues/1083) describes different start/end timestamp behavior, including offline playback. This is a third-party issue report, not a current guarantee or a measurement on this user's account.
- [Historical cursor report](https://github.com/spotify/web-api/issues/627) reports an empty result for older history. Do not treat cursors as a guaranteed complete lifetime archive.

A combined collector could retain observed brief tracks absent from recently played, but it cannot fill unknown gaps reliably. Conflicting sources must invalidate adjacency rather than allow either source to overwrite it silently.

## Exact playback/queue limitation

[Start/Resume Playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback?body=%7B%22uris%22%3A%5B%22spotify%3Atrack%3A7fODjB7BrQTGqh0hogW6XD%22%5D%7D) supports starting a new context or resuming playback, including `uris`, `context_uri`, `offset` and `position_ms`. It requires Premium and `user-modify-playback-state`.

Supplying `uris: [historicalUri], position_ms: 0` can select the track, but the documentation does not promise preservation of the remaining queue or existing context. It is **not** a queue-preserving history-Back primitive. Supplying context/offset instead is not a general solution: reported context does not identify a unique occurrence, particularly with duplicate playlist tracks, shuffle, or queued tracks.

[Get Queue](https://developer.spotify.com/documentation/web-api/reference/get-queue) gives a snapshot, not a transactional restore token or the complete playback context. Do not reconstruct or replace the queue using this response. Queue-and-skip is not an alternative: appending does not put the candidate immediately next and adds more writes.

Queue/context risk alone could be addressed by disclosing it and obtaining explicit approval for a risk-bearing replay. That is not inherently prohibited by the request. However, this would not resolve the independent history-identity blocker above. No risk-bearing replay has been added under the name Back.

Suggested disclosure for a separately approved future replay design:

> Play this confirmed historical track from the beginning on the current active device? This starts playback even if paused. Spotify may replace the playback context or alter the remaining queue; preservation is not guaranteed.

Approval must precede the write, not appear only in the result. No permissive default, inferred acknowledgement, implicit transfer/open, or queue restoration is acceptable.

## Proposed occurrence and cursor contract — NOT IMPLEMENTED

If a trustworthy event source becomes available, or the user explicitly approves a confirmed-candidate/observed-history design, the following remains required:

- Occurrences, not a set of URIs: A₁ → B₂ → A₃ are three distinct entries. Duplicate snapshots of the same occurrence and seek-to-zero do not add entries. Same-URI uncertainty after a gap cannot be resolved from URI equality alone.
- Store only bounded minimal data: proposed maximum 50 occurrences and a 24-hour age limit, with no artwork, titles, profile details or listening analytics unless needed. Prefer session memory. Persisting history or pending state requires a reviewed storage permission and expiry on load as well as write. Do not collect history merely to support a disabled button.
- Scope state to a verified account identity, never just the OAuth client ID or device ID. SDK v1 has no account-generation notification. A future implementation must validate identity through the existing authenticated service before reusing state, or discard state when identity cannot be established. Expired/missing authorization must not expose/replay the previous account's entries.
- Account/device changes, unsupported content, missing observations and conflicting timestamps break adjacency. Device changes end the navigation session even if the track URI matches. Unknown entries are barriers, not items to skip over.
- Deduplicate repeated recent-history responses using occurrence evidence such as URI + reported timestamp within that source; same URI at different times remains distinct. A timestamp tie is ambiguous. Cross-source URI equality is not an occurrence match. Do not merge two occurrences merely because they fall inside an arbitrary time window.
- Explicit cursor points into a frozen backward-navigation chain. C₃ → Back B₂ → Back A₁ decrements that cursor. Observations of replayed B₂/A₁ acknowledge navigation; they do not append tail entries that produce a bounce loop.
- Track pending source occurrence, target occurrence, device, account generation and outcome separately from committed cursor. Record pending intent before dispatch. A rejected write does not commit a cursor. Accepted is not observed. Unknown writes remain pending and cannot be replayed automatically.
- Reconcile a pending action using one separately requested foreground read. A matching URI alone is insufficient with repeated occurrences or concurrent changes. If unresolved, disable further Back and explain why; do not retry or advance by assumption. Storage failure before dispatch must prevent the write; failure after dispatch must not turn uncertainty into success.
- Serialize history-affecting actions; prevent overlapping preflights/Back writes from racing cursor commits. SDK cancellation after dispatch is still an uncertain outcome. Do not hide late effects behind a new navigation session.
- Normal track progression, explicit Next/native Previous, or external track selection ends backward navigation. Seek/restart and pause do not fabricate a transition. Intent to leave navigation and successful transition observation must remain separate so a rejected Next does not falsely record a new track. Uncertain Next invalidates adjacency pending reconciliation.
- Paused playback is allowed only as explicit approved playback intent: Back selects the prior occurrence at zero and starts it. It must not resume the unrelated current item as a fallback. The active controllable device guard remains mandatory.
- Missing scopes/401, 403 restrictions or Premium limitations, 429 with Retry-After, unavailable/local tracks, episodes/ads, and unknown outcomes must be specific failures, never triggers for native Previous or an older candidate.

There is currently no claimed cursor implementation or passing Back-navigation test suite.

## Permissions and authorization

**This revision:** no additional permissions or OAuth scopes; no reauthorization needed because of these changes. Network hosts, `spotify:` opening permission, existing action approvals and three existing playback scopes are unchanged. Storage remains disabled. No listening-history data is retained.

**Future recent-history integration:** add `user-read-recently-played` and require reconnection/reauthorization in Settings → Plugins; an existing token will not automatically acquire the new grant. Register any Back replay as effect `write`, requiring a separate `action:history_back` approval. Any storage and additional identity-scope needs must be reviewed against the chosen design, not requested speculatively now.

## Widget handoff

There is no widget to rebind. No UI host is implemented in SDK v1. Do not invent host methods or add polling to mimic one.

For a future reviewed host integration, use the existing foreground refresh lifecycle only. Render a disabled Back control with tooltip/reason: **“Back unavailable: reliable listening history is not available.”** Once a genuine action exists, its normal tooltip should be **“Back to the last track heard.”** Native Previous, if exposed, remains separately labelled **“Spotify native Previous.”** Restart uses seek-to-zero. An enabled control must use the normal approval path and disclose queue/context risk before dispatch. UI work alone cannot repair missing Spotify events.

## Test status and required future matrix

This revision adds only manifest-contract tests: native Previous is explicitly not Back, remains approval-gated, no unimplemented Back handler is advertised, and no speculative history scope/storage is requested. Existing playback mocked regressions are run separately. These are **not** tests of an implemented history service.

Before any future implementation is called complete, mocked service tests must cover:

| Scenario | Required assertion |
| --- | --- |
| A → B → C, Back → B, Back → A | Cursor decreases; replay acknowledgements never append loop-causing occurrences |
| A₁ → B₂ → A₃ | Occurrences remain distinct despite matching URIs |
| Restart and duplicate snapshots | No false occurrence |
| Lagging/empty/incomplete recent history | Unknown adjacency disables Back; no older fallback |
| Briefly skipped observed track | Retained as an observation even if absent from recent history, without inventing adjacency across a gap |
| Conflicting ordering/timestamp ties | Refuse ambiguous occurrence merge |
| External selection/device/account changes | End navigation; reject stale target/account state |
| Paused playback | Explicit replay starts prior track at zero, not resume-current fallback |
| Rejected write | Cursor not advanced; no retry |
| Accepted but unobserved/unknown write | Pending barrier retained; no blind repeat or immediate cursor bounce |
| Missing scope/401/429 | Specific remedy; no write or repeated request loop |
| Unplayable track/unsupported content | Refuse without searching for an older substitute |
| Queue/context risk | Explicit approval precedes write; no preservation assertion or partial-snapshot reconstruction |
| Cancellation/concurrency/reload/storage failure | No duplicate dispatch or falsely committed cursor |

## Controlled TV manual plan — NOT RUN

No development playback calls were made. The following is a future plan, not authorization or a runnable Back test in this revision.

1. First verify the current safety revision in chat: “Back to the song I just heard” must explain unavailability and produce **no** playback write. “Spotify native Previous” and “restart this song” must remain distinct intents. Do not execute either mutation without user approval.
2. Only after a real replay implementation is separately reviewed, explain queue/context risk and ask permission for each mutation. Choose a disposable test playlist/queue and the explicit current TV device. Do not test on a valuable live queue.
3. Before each Back, capture the remaining queue in the Spotify UI and one available API queue snapshot. Record order, duplicate occurrences, manual queue entries, active context, shuffle/repeat and current track/progress. The UI comparison matters; the API snapshot alone is incomplete.
4. With explicit user actions, hear A then B then C, including one short play. Record TV display and one foreground API observation per step; note whether any changes occurred between observations. Execute one approved Back, read once, compare TV title/progress to B near zero. Repeat for A. Treat API acceptance separately from the observations; never retry just because a snapshot lags.
5. After **each** Back, compare the remaining queue/context with the before record, including duplicates and its next several actual plays. Record changed/unchanged/unknown; a few successful trials do not establish a universal API preservation guarantee.
6. Repeat A → B → A and restart-current. Test paused Back separately with explicit acknowledgement that it starts playback. Check native Previous separately only if requested.
7. Deliberately make an external selection or switch devices between observations; Back must refuse ambiguity rather than pick an older known track. Test missing history scope, 401/429, rejected commands and response loss with mocks, not by disrupting the live account/network.
8. Stop on unexpected queue changes, unknown outcome, device mismatch or unresolved target. Do not auto-restore a queue from a snapshot or replay an uncertain write.

## Delivery status

- Implemented: assistant intent distinction, native tool wording/label, blocker/design/widget/manual-test documentation, manifest safety tests.
- Not implemented: history fetch/collector/reconciliation, history-based Back tool/service, persistent cursor/pending state, or widget binding. This is not a complete implementation of the requested feature.
- Mocked tests: see the actual `plugin_validate` / `plugin_test` results reported in the development conversation; no unrun tests are claimed here.
- Live verified during this work: nothing. No playback was read or changed.
- To unblock: an authoritative occurrence source, or an explicitly approved contract change to confirmed-candidate/observed-history replay with disclosed queue/context risk. A Custard-only UI or storage change cannot manufacture missing Spotify playback events.
