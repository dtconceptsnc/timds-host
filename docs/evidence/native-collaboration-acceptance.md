# Native collaboration acceptance — 2026-10-13

Actual toolkit CLI implementation (`runHostedCommand`, commit `4fbdf799`) and
authenticated host API operations ran against the separate disposable source
`d627d943-8c0c-4aa8-bbad-67dbc6bae37e` (`timds/collaboration-proof-69`).
The source used the existing acceptance organization and native Artifacts
binding. It created no publisher grant or additional identity. No tests or
test harnesses were written or run.

- Start and join materialized 68 files in two independent workspaces at the
  same session revision. Both used the existing human owner; this does not
  claim cross-principal authorization coverage.
- Advisory claims persisted with the requested paths and `kind: advisory`.
- Different keys in `tokens/color.json` merged after a stale workspace update:
  saved accent `#3157d6` and local muted `#536876` both survived. The CLI used
  the normal stale response and one rebase retry.
- Competing edits to `accent.value` returned exact base/mine/theirs values
  `#3157d6` / `#4057d6` / `#3657d6`, with `stale: true` and `applied: false`.
  The local proposed value remained intact.
- An obsolete conflict-resolution `mainRevision` returned HTTP 409; the
  session revision was unchanged. Explicit `theirs` resolution at the current
  revision succeeded and retained muted `#536876`.
- Normal close completed with session and live state `closed`. A subsequent
  join returned HTTP 410; active work was empty and publication history stayed
  empty. The source itself remained intact for the next coordinated lifecycle
  verification.

The sanitized [receipt](native-collaboration-receipt.json) contains exact
identities, revisions, response statuses, conflict values and timestamps.

## Coordinated source lifecycle verification

After the collaboration proof, the operator explicitly authorized retirement of
this disposable source. Archive returned 200 and authoring returned 409 while
archived; restore returned 200 and authoring became available again. The
deletion review bound the exact repository provider ID `2ntf3pzawyf5vidv` with
zero active sessions, forks, publishers or Requests. Its impact hash and typed
repository name were confirmed through the normal API. Operation
`a77b4032-aec1-432f-8d94-0c18d9660411` completed at
`2026-10-13T14:44:09.600Z` without an error.

Anonymous public access returned 404. Authoring remained unavailable (409),
while the administrator retained minimal source identity with lifecycle
`deleted`, one session descriptor, and ten audit events. Replaying the original
provision operation returned the retained deleted source; attempting a fresh
provision operation with the same identity returned 409. The source remained
deleted after both calls. No raw-state patch or forced resource removal was
used. See the sanitized [lifecycle receipt](native-lifecycle-receipt.json).
