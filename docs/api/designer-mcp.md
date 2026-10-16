# Designer contributions over MCP

For installation and a walkthrough across Studio, CLI and both MCP transports,
start with [contributor setup and lifecycle](../contributing-design-systems.md).
This document specifies the remote host's tools and receipts.

Connect an MCP client to the host's authenticated `/api/timds/mcp` endpoint.
For example, `https://timds-example.example.com/api/timds/mcp` uses the same
OAuth authorization and existing Design System grants as Studio and the CLI.
Read access uses `timds:read`; contribution tools additionally require
`timds:write`, and the endpoint's sign-in challenge asks for both so a client
that follows it can contribute. The host also accepts its explicitly configured Studio origin.
The anonymous `/mcp` endpoint on the public origin exposes published reads
only, with `systemId` as a tool argument; the same files are also readable
without MCP at `/systems/<org>/<name>/` (see
[published derived layer](published-derived-layer.md)).

An agent can edit a hosted session directly or send an instruction to the
host's designer runner. Both paths produce the same sessions, claims, activity,
submissions and frozen Previews that Studio and the CLI use. A system does not
need a published version before an authorized contributor starts work.
Publishing and rollback are separate, explicit publisher actions available in
Studio, the CLI and remote MCP. Submission and checks do not publish.

The remote tools enforce the toolkit's authored-surface/protected-path policy
over hosted snapshots, with the same manifest layout, grouped-contract,
configured local-video and ignore boundaries. Remote checks run in an isolated
host build runtime; local toolkit MCP runs against a local filesystem. Their
tool names and transport differ, while the session and publication authority
remain shared.

## Tools

The published tools remain available on both endpoints. They take an immutable
`systemId` and optional published `version`; omitting `version`, or passing
the tag `latest`, resolves the current publication on every call.

| Tool | Result |
| --- | --- |
| `describe_system` | Published system metadata, page directory, token summary and public URLs. |
| `get_tokens` | Bounded, optionally filtered resolved CSS tokens. |
| `read_page` | One published guidance page or block as Markdown or structured blocks. |
| `read_derived_layer` | A bounded published derived layer and the exact release receipt; see [published derived layer](published-derived-layer.md). |

Authenticated contribution reads use current source and session authority.
Their `systemId` accepts either the source UUID or the immutable system ID
returned by `list_systems`. Session and Request identifiers come from host
receipts, not a published release.

| Tool | Result |
| --- | --- |
| `list_systems` | The active Design Systems available to this principal. |
| `get_system` | Current release metadata and the bounded release catalogue for one source. |
| `get_active_work` | Sessions, drafts, members, advisory claims, runner/queue state and recent activity. |
| `get_session` | Session status, membership, claims, submissions and live state. |
| `get_session_history` | Commit and append-only event history for a session. |
| `list_session_files` | A bounded source-file inventory and the session revision receipt. |
| `read_session_file` | One bounded, safe source file with its session revision receipt. |
| `list_drafts` | Open named drafts. |
| `list_submissions` | Frozen source submissions, Preview URLs and publication status. |
| `get_request` | A Request's queue/runner state and resulting session/submission. |
| `get_events` | Source events after a sequence cursor, with pagination information. |
| `get_editing_guide` | Authoring rules, protected paths, validation and handoff guidance. |
| `get_skill` | The Agent Skills `SKILL.md` for one Design System on this host, with its skill name and save path. |
| `describe_workspace` | Session workspace identity, layout, authored paths, protected paths and configured commands. |
| `list_media` | Bounded media catalog entries for a session, optionally filtered by tag. |
| `get_check` | A saved check's progress/result and exact snapshot receipt. |
| `read_derived` | A bounded document produced by a specific completed check, with freshness against the current session. |
| `list_principals` | Eligible people and agents for session invitations. |
| `get_session_link` | A Studio URL on the configured origin, optionally marked for self-join. |
| `list_draft_files`, `read_draft_file` | The same bounded authored-file reads for a source-authorized draft selected by name or UUID. |
| `get_publication` | Publication stages, queue state and completion/error receipt. |

The following tools are available only to callers with write scope. Each call
still checks current principal, source and session permissions.

| Tool | Action and retry identity |
| --- | --- |
| `start_session` | Create or recover a session; requires a stable `idempotencyKey`. May start from a published version or an open named draft. |
| `join_session` | Join as the authenticated caller. It cannot select or invite another principal. |
| `claim_session` | Declare advisory path patterns and intent; claims warn about overlaps and do not lock files. |
| `update_session` | Reconcile a changeset with the session's target, preserving revision and conflict checks. |
| `submit_session` | Freeze a changeset into a submission and Preview, or integrate a child session into its target draft. |
| `close_session` | Close a session and release its resources; closing a draft also closes its child sessions. |
| `create_draft` | Create or recover a named shared draft; requires a stable `idempotencyKey` and the original name/from on retries. |
| `create_request` | Queue a prompt in a new session or a specified `sessionId`; requires a stable `requestId`. |
| `report_gap` | Create a Request about a published release after the user agrees to report it; identical caller/release/report inputs reuse the Request. |
| `run_check` | Validate an exact saved session snapshot with stable `checkId`, `baseRevision` and `lastUpdateHash`; no publisher grant is needed. |
| `invite_session_member` | Invite a selected eligible principal; requires owner/publisher authority. |
| `close_draft` | Close a named/UUID draft and its child sessions with existing close authority. |
| `preflight_submission` | Review publication readiness for a submission under current publisher authority. |
| `check_submission` | Perform publication preflight plus the existing dry-run merge/build/check; it does not publish. |
| `publish_submission` | Explicitly queue publication of a reviewed immutable submission; returns a publication to poll. |
| `preflight_rollback` | Review an immutable target version and the current pointer under publisher authority. |
| `rollback_system` | Restore that reviewed version with a stable operation UUID and expected-current pointer guard. |

## Reading source files

`list_session_files` takes `sessionId`, optional safe path `prefix`, lexical
cursor `after`, and `limit` (default 100, maximum 200). It returns `session`,
`files` entries with `path`, `size`, `sha256` and `mode`, plus `total`,
`returned`, `limit` and `nextAfter`. Use `nextAfter` as the next `after` value
until it is null. The inventory contains only permitted authored source paths.

`read_session_file` takes `sessionId`, `path`, optional `encoding` (`utf8` or
`base64`), byte `offset` (default 0) and byte `limit` (default 65,536, maximum
262,144). Its `file` result contains the same file metadata plus `encoding`,
`offset`, `length`, `nextOffset` and `content`. Use `nextOffset` for the next
chunk until it is null. A chunk containing invalid UTF-8, a partial code point
or a NUL byte is returned as base64 even when UTF-8 was requested. Decode each
chunk according to its returned encoding and join the bytes before decoding
the whole text.

Both tools return the session's current `baseRevision` and `lastUpdateHash`.
Compare these across pages and compare a file's `sha256` across chunks; restart
the read when they change. The byte cursors describe one snapshot and do not
pin later calls to it. Underlying source limits remain 4,000 files, 50 MiB per
snapshot and 10 MiB per file.

While a session is `starting`, `list_session_files`, `read_session_file`,
`describe_workspace`, `list_media` and authored-change authorization use the
same pinned revision as start. The host first checks the revision index and
reads an indexed source tree from R2. On a miss it tries direct Artifacts reads
within the 200 combined tree-read/file-entry budget, then falls back to the
repository container for larger trees or symlinks. For an open session whose
fork head still matches `baseRevision`, an indexed tree avoids the container;
changed or unindexed heads and historical sessions without a fork creation
receipt retain the container path. Current source and session authority are
rechecked before returning the tree.

R2 metadata reads use the verified manifest; direct Artifacts metadata reads
stream four blobs at a time, verify Git identity and compute sizes/SHA-256
without retaining a whole tree. Selected file bytes are reread and verified.
Update and submit wait up to 45 seconds for the fork, then recheck current
authority and concurrency guards. CLI, MCP and Studio use the same host start
and eager-wake policy.


`list_draft_files` and `read_draft_file` replace `sessionId` with `systemId`
and `draft` (draft name or session UUID). Their prefix, cursor, encoding and
byte limits are the same. Reading a draft does not join it; join its session
before attempting member-only editing operations.

Start, update and submission receipts omit full file trees. When present,
`filesOmitted`, `baseFilesOmitted`, `rebasedChangesOmitted` and `rereadRequired`
tell the client to fetch the relevant files again instead of assuming it has
the complete reconciled source.

## Direct contribution workflow

1. Call `list_systems`, then `get_active_work` for the selected system. Read
   relevant published guidance when available and inspect other contributors'
   claims before choosing the work.
2. Reuse an existing session through `join_session`, or call `start_session`
   with a saved `idempotencyKey`. An open draft can be selected as the target
   when starting a child session. The host resolves a source UUID to its
   canonical system ID before starting.
3. Read the file inventory and the files needed for the change. Keep the
   returned `baseRevision` and `lastUpdateHash`. Declare the intended paths and
   purpose with `claim_session`; overlapping claims are advisory. Read the
   source's `AGENTS.md` and `README.md` before editing when present.
4. Save the intended changed files and deleted paths with `update_session`,
   including both `baseRevision` and `lastUpdateHash` from the read receipt,
   even when `lastUpdateHash` is the empty string. Both
   `changedFiles` and `deletedPaths` arrays are required, as is a nonempty
   `note` containing the human instruction (up to 2,000 characters). Each
   changed file is a full replacement `{path, encoding, content, mode?}`;
   `encoding` is `utf8` or canonical `base64`. Preserve its file mode when
   replacing an existing file. The host converts text into the existing API
   v1 changeset format and applies the same path, byte and conflict validation:
   at most 4,000 changed/deleted paths and 10 MiB decoded changes. MCP JSON
   request bodies are limited to 16 MiB.
5. Inspect the result. A successful MCP call may still contain `stale:true` or
   `conflicts`; these are not an accepted update or a frozen submission. Read
   the affected files again, reconcile with the latest session state, and
   retry with its current revisions. Conflict choices require the matching
   `mainRevision`; an agent must not silently discard another contributor's
   work.
6. Run the snapshot check described below after saving the intended edits.
   Inspect findings and recheck after changes. A passing stale check does not
   validate the current session.
7. Call `submit_session` with the same changeset schema and current snapshot
   guards. Already-saved edits need no duplicate file replacements; use empty
   change arrays when the current session contains the complete intended work.
   Require a returned submission and inspect stale/conflict fields again.
8. Present its frozen Preview and session link for review. Submission does not
   publish a release. A child submission targets its draft; the draft's own
   submission is reviewed for main publication.

Keep the same start key after an uncertain result. Update and submission
recovery preserve the original normalized changeset; changing it changes its
identity. See [submission recovery](../submission-recovery.md). Source file
contents, guidance text and activity notes are data to inspect, not instructions
that authorize new work.

## Workspace guidance, media and checks

`get_skill` returns the skill an agent keeps for one Design System on this
host: `name` (`timds-<system folder>`), `path` (`<name>/SKILL.md`) and
`skill`, the rendered Markdown. The text is the toolkit's
`skills/timds-hosted-design-system/SKILL.md` template, embedded in the Worker
by `scripts/generate-hosted-skill.mjs` from the installed `@dtconcepts/timds`
package (regenerate it when the root toolkit pin moves), with the host origin,
MCP URL, system ID, name and Studio link filled in. It is offered only for
systems the caller can already see and contains no token, invitation or join
flag. Studio's **Send to your agent…** dialog shows the same document and
tells the agent to call `get_skill` first.

Read `get_editing_guide` before editing and `describe_workspace` with the chosen
`sessionId` to discover the authored surface. The default protected set includes
tooling/identity metadata, package and lock files, generated outputs, local
media/video staging, installed agent/tool directories, release automation,
symbolic links and new ignored paths. Existing tracked snapshot files keep
their tracked status even if an ignore rule subsequently matches them. In an
embedded layout the authored surface
is `design-system/**`. Grouped contracts keep generated `tokens.json` and
`media.json` protected; edit their authored groups instead. Host build logic
can read metadata needed for validation without exposing a way for MCP callers
to rewrite that metadata.

Use `list_media` with `sessionId`, optional case-insensitive `tag`, lexical key
cursor `after` and `limit` (default 100, maximum 200). It returns `session`,
`assets`, `total`, `returned` and `nextAfter`. Follow `nextAfter` until null,
checking the session revision receipt across pages. Grouped media files are
composed without changing generated `media.json`; results contain bounded
catalog metadata and accepted stable public URLs. Reference these existing
keys in authored source. File changes are not binary media uploads. Use the
separate [media workflow](media.md) when adding assets.

`run_check` takes `{sessionId, checkId, baseRevision, lastUpdateHash}`. Save a
fresh UUID and the exact snapshot guards before the call; retries of the same
check keep all four values. It runs controlled validation in the isolated build
runtime against that snapshot without editing, submitting or publishing the
session. `get_check` takes `{sessionId, checkId}` and returns progress and the
saved result. Both return `{apiVersion, session, check}`. The check contains
`id`, `sessionId`, `baseRevision`, `lastUpdateHash`, `status` (`running`,
`passed` or `failed`), `checks`, `createdAt`, `completedAt`, optional `error`
and `stale`. `run_check` normally waits for completion; `get_check` observes
the saved record and does not start or resume work. After a timeout, read the
receipt and repeat `run_check` with its original identity and guards when a
running check needs resuming. Resumption requires an open, unexpired session.
A completed retry returns its retained receipt even after the session closes,
subject to current authority; closed or expired sessions make `check.stale`
true. A completed failed check keeps its receipt; correct the source and use
a new check UUID for another attempt. Check failures are safe
host-authored categories, not raw provider responses or arbitrary source-program
logs.

Receipt reads refresh an open session's authoritative fork before reporting
freshness, so direct CLI or runner pushes also invalidate an older check.
Closed sessions use retained session state without reopening their runtime.

These are fixed coordinator operations reached through MCP, not additional
REST check endpoints. Check records and immutable input/output snapshots use
the existing coordinator and SNAPSHOTS retention; session close is not an
immediate check-artifact deletion request. The builder cleans up its container
and has a 20-minute inactivity alarm. Dependency preparation uses its separate
controlled cache path; source check commands run offline without host
credentials.

`read_derived` takes `{sessionId, checkId, name, offset?, limit?, encoding?}`.
`name` selects `brand`, `tokens`, `index`, `formats`, `designs`, `changelog`,
`bundle`, `llms` or `llmsFull` from that successful check's bounded output.
JSON documents keep their named `.json` files; `llms` reads `llms.txt` and
`llmsFull` reads `llms-full.txt`. Paths are relative to the immutable source
manifest's artifact entry directory, matching the pinned toolkit's derived
layout. Optional documents return 404 when that check did not produce them.
Use `list_media` for the source media catalog; it is not a derived document.
The result is `{apiVersion, session, check, file, limit}`; `file` has the same metadata,
encoding and byte cursors as `read_session_file`, with a default 65,536-byte
page and maximum 262,144 bytes. Decode the returned encoding and follow
`nextOffset` until null. `check.stale` compares its saved revision/hash with the
current session and requires that session to remain open and unexpired. Treat
that receipt as part of the data: a check of an earlier snapshot does not
establish that a later edit passes. Contributor snapshot checking and publisher
`check_submission` have different purposes; publication still validates the
immutable submission merged with current main.

## People, review, publication and rollback

`list_principals({systemId})` returns people and agents already eligible for
this source's sessions. `invite_session_member({sessionId, principalId})`
uses the existing owner/publisher invitation check. `join_session` always acts
as the authenticated caller. None of these tools grants publisher authority or
creates a new source-access invitation.

`get_session_link({sessionId, join?})` returns
`{apiVersion, sourceId, sessionId, url, join}`. The URL uses the configured
Studio origin, falling back to the host origin, with
`#source=…&view=studio&session=…` and optional `join=1`. Host configuration
selects its origin; tool input cannot substitute a foreign origin.

For a reviewable main submission, call
`preflight_submission({submissionId})`, optionally
`check_submission({submissionId})`, then obtain the user's explicit publication
instruction before `publish_submission({submissionId})`. The first two return
`{apiVersion, preflight}`. Publishing returns `{apiVersion, publication}`;
poll `get_publication({publicationId})` and retain its ID across disconnects or
uncertain responses. A publisher grant is checked for preflight, build check
and publication, and again before pointer commit. A child submission integrated
into a draft cannot publish main directly.

Publication passes through preflight, merge, build, prepare, release, flip and
close. Queue acceptance is not completion. `closing` means the public pointer
has committed and cleanup remains; retry/poll the same publication rather than
closing its session independently. Present the final receipt and Preview/public
links accurately. The [publication recovery guide](../publication-queue-recovery.md)
describes unsettled or failed attempts.

Rollback is a separate reviewed action:

1. Select a prior version UUID from `get_system`'s release catalogue and call
   `preflight_rollback({systemId, versionId, reason?})`. It returns
   `{apiVersion, dryRun:true, sourceId, versionId, currentVersionId}`.
2. Review the target and current release, then call
   `rollback_system({systemId, versionId, operationId,
   expectedCurrentVersionId, reason?})` only for an explicit restore request.
   `operationId` is a stable UUID; `expectedCurrentVersionId` is the exact
   preflight UUID or null. A reason, when supplied, has at most 2,000 characters.
3. Preserve the same operation, target, reason and expected pointer on retry.
   A changed retry conflicts. A changed current pointer conflicts before the
   first commit and requires renewed review. An already committed retry returns
   its saved receipt, even after a subsequent publication, without moving the
   pointer again. Current publisher authority is required for that replay too.

The restore result includes `{apiVersion, action:'rollback', operationId,
previousVersionId, result}` with artifact/publication/version receipts.
Immutable release history is retained. Closing is independent:
`close_session({sessionId})` or `close_draft({systemId, draft})` releases the
working resources with existing owner/publisher/operator checks; close a draft
only when closing its children is also intended.

## Designer Request workflow

Use `create_request` when the host's designer should implement the user's
instruction. Supply a UUID `requestId` and keep that UUID, prompt and original
target unchanged across retries. Omit `sessionId` for a new session; choose an
existing session or draft only when the caller owns it or has publisher
authority. Session membership alone does not authorize a targeted Request.

Call `get_request` with the returned identity to follow its queue position,
runner, safe error and resulting submission. Requests aimed at the same session
run in order. A newly returned session ID does not change the original retry
target. Follow-up instructions use a new Request UUID. Request submission and
Preview readiness still require review before publication. See
[Requests and native live sessions](../../src/requests/README.md).

`get_events` also follows progress without opening a WebSocket. Supply `after`
as the last event sequence already seen and a `limit` of up to 500 (default
100). Use the last returned event's `seq` for the next page while `hasMore` is
true. `latestSeq` is the source's high-water mark, which can be beyond the
current page; using it as the cursor before consuming every page skips events.

## Authority and output boundaries

MCP uses the same coordinator operation allowlist as the HTTP API. It never
accepts an actor, principal override, repository capability or storage object
reference from tool input. Each call rechecks the active identity and current
source/session authority; OAuth scope adds no source permissions. Write tools
explicitly check write scope because the MCP transport itself admits read-only
clients. Joining a session adds membership only. Closing still requires the
owner, a publisher or the existing operator authority.

Source reads and changes apply the authored/protected-path policy in addition
to the API's unsafe/private path exclusions. These rules do not inspect
arbitrary file contents for credentials. Large source snapshots
remain internal storage references until a bounded file is selected; MCP
outputs do not expose those references. Session mutations return revision,
submission and conflict receipts without dumping the source tree. Clients can
fetch the files they need after a change.

Every transport request creates a fresh MCP server. Actor, selected source and
published release state are not retained across callers. The endpoint enforces
its configured origin, rejects foreign browser origins, and marks responses
`no-store`. Host-authored errors and existing safe conflict receipts are
returned; provider bodies and credentials are not.

Contribution tool failures set MCP `isError:true` and include
`structuredContent.error` with `statusCode` and `message`. Existing client
errors retain their host-authored status and message; other failures return a
generic 503 message. A conflict error may also include `conflicts` and
`mainRevision`. Successful contribution results are available as
`structuredContent` and JSON text; inspect `stale` and `conflicts` there as well
as protocol-level errors before reporting that a write succeeded.

## Validation

Remote contribution is implemented, but Studio keeps its `preview` badge until
authenticated deployed acceptance is observed. Local compilation, bundling,
syntax, smoke, documentation and public-boundary checks establish local
correctness only; they do not establish OAuth client compatibility or deployed
editing behaviour.

On an explicitly authorized disposable source, deployed acceptance should
cover OAuth discovery/sign-in, read-only tool availability, denied write/grant
combinations, source discovery before publication, start retry, self-join and
invitations, bounded authored-file/media reads, protected paths and symlinks,
claims, conflicting/stale edits, exact-snapshot checks and derived reads,
submission/Preview readiness, draft integration, Request retry/polling,
publisher preflight/build/queue/polling, guarded rollback/replay and cleanup.
Confirm that checks and submission leave the public pointer unchanged and
only explicit publication/rollback move it. Public `/mcp` must continue to
expose only published reads. Keep receipts
outside this repository and follow [verification](../verification.md); running
the live conformance harness requires explicit authorization.
