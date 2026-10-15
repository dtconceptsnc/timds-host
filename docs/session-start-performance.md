# Session start performance acceptance

The implementation shares one start path across CLI, authenticated MCP and
Studio. Local build checks do not establish its latency. Run the sequence below
only after the operator authorizes deployment and selects a disposable source;
follow the [conformance fixture rules](../conformance/README.md). Keep identities,
source revisions, credentials, logs and operational receipts outside this
public repository. Do not use a real design system as a performance fixture.

## Record a comparable start

Use a small synthetic source within the direct Artifacts limit (200 combined
directory reads and files). Record cold and warm samples separately, with the
same source shape, dependency-cache state and instance sizes. For each client:

1. Start with a fresh idempotency key; record invocation, dispatch, response
   headers and body consumption. The CLI can use the opt-in profiler described
   in [operations.md](operations.md#measure-the-installed-cli). MCP harness
   timings begin at its local tool call; host logs cannot observe time before
   a client dispatches a request. Studio can use browser Network timing.
2. Immediately pull, or call `list_session_files` and `read_session_file`.
   Compare the returned `baseRevision`, file identity and bytes with start.
   Do not wait for `open` before this read. The response may already be open
   if preparation won the race; never require `starting` in a latency sample.
   Record each MCP call's elapsed time and compare it with time to `open`:
   indexed reads use R2 manifest metadata; unindexed direct Artifacts reads
   still hash the pinned files for each call. Separate these cases in the
   measurement and require matching bytes in both.
3. Replay start with the same key and origin; require the same session and
   pinned revision. A changed origin must fail. Record an immediate update
   and submit separately, including any 409 and elapsed wait. The write wait
   is bounded at 45 seconds and is subject to measured confirmation after
   deployment. Keep this bound unless the authorized fixture's fork exceeds
   it; only then raise it to 60 seconds in code and every API description.
4. Poll status and diagnostics without opening the live URL or sending feed
   viewing messages. Require fork completion at the returned revision,
   `startRecovery.wakeIssued`, and a live URL when both provisioning jobs
   finish. URL publication waits for the real runtime wake-start receipt,
   observed for up to 30 seconds while subscription provisioning runs. Observe a wake start before any viewer request; then open the URL
   and verify actual preview content. A URL or `ready` label alone is not
   proof that the preview serves the intended files.
5. In Studio, separately verify placeholder-to-frame transition from its feed
   without reloading. Exercise a designer Request through submission, then
   run the full authorized `conformance` `npm run test:host` flow.

Read diagnostics once during each phase and after settling. Query Workers Logs
by session UUID as shown in [operations.md](operations.md#logs-and-observability).
Record `fork`/`host`/`live` totals and each applicable stage, including
`live-worker-get` (script settings, with ownership tags) rather than an account
list. Verify host work starts before fork completion, `live-wake` is issued as
soon as the fork opens, and subscription provisioning overlaps the wake.
Conditional upload/subdomain-lookup stages may be absent after reuse. Retried
stages have multiple log entries; diagnostics retain latest observations.
`response-files` ends on stream completion, error or cancellation, and cannot
be added to the already-sent header. Do not sum overlapping stages.

Also accept a source with a safe symlink: its first unindexed start keeps the
container fallback and all file/byte limits. Later indexed reads must preserve
the same paths, modes and bytes. Test an old operation-scoped source snapshot
reference and an `artifact: true` build-check reference to establish that
stored publication/submission receipts remain readable.
Test expired/revoked starts, exhausted retries, an explicit start retry,
close during either live lease, and deletion during host work. Refusals must
leave no unauthorized checkpoint or newly orphaned resource.

## Accept a real-sized indexed tree

Use a synthetic fixture with a few hundred files, tens of directories, mostly
binary content and no symlinks, beyond the 200-entry direct-read budget but
within the unchanged source file/byte limits. Run the sequence from CLI,
authenticated MCP and Studio against the same pinned revision. Separate
request logs (`session-start`) from the alarm's fork logs (`session-start-job`)
and snapshot lookup logs (`session-snapshot`). Record body completion, not
only response headers.

1. Start a previously unindexed revision. Require the blocking container path
   to return the full tree and record it for both origin and fork at the
   returned `baseRevision`. Compare all returned paths, modes and bytes with
   the fixture. The first copy may read every unique blob from the container.
2. Start that same revision with another fresh idempotency key and replay the
   starting session's key. Require `tree-index` with `hit: 1`, no per-file
   Artifacts reads and no request-side `repository-*` stages. Confirm that
   an origin advancing later does not change the replay's pinned revision.
3. On an open session with unchanged fork head, call MCP `list_session_files`,
   then `read_session_file`, then `timds pull`. Require one fork-head lookup
   and an indexed tree without a repository container. Require these lookups
   to use operation `session-snapshot` while start replays use `session-start`.
   Repeat for a named
   draft snapshot. Change the head and require a fallback followed by a new
   immutable index entry; revoked access must refuse both paths.
4. Inspect the second start's background fork. Require no `repository-files`
   stage, the exact pinned fork revision and the copied origin index entry.
   Record time to `open` and whether an immediate write finishes inside the
   existing 45-second wait.
5. Update or snapshot through the container path, then repeat a copy with
   unchanged content. Compare `repository-files` durations and
   `blobsRead`/`blobsFound` in `repository_step` (or `session_start_step` for
   starts). A fully repeated manifest must read no container blobs; a partly
   changed tree should reuse unchanged blobs. Compare `response-files`
   separately because response streaming follows tree preparation.

| Scenario | Phase 2b acceptance target |
| --- | --- |
| First start of a new revision | Complete tree returned and indexed; later copies increase `blobsFound`. |
| Second start of the same revision, from any client | Complete response under 5 seconds; index hit and no request-side container stages. |
| MCP list/read and `timds pull` on an open unchanged session | Each under 5 seconds with no container stage. |
| Background fork | No `repository-files`; reaches `open` within the write wait. |
| Repeat `repository-files` copy | Under 10 seconds on this fixture. |
| `response-files` | Under 5 seconds on this fixture. |
| Start to usable preview, dependency-cache hit | About 60 seconds before Phase 3 wake tuning. |

These are deployed acceptance targets, not results of local checks. The
initial unindexed fork still blocks; indexing and shared blobs remove repeated
work rather than establishing a cold-start latency guarantee. Preserve the
private receipts needed to compare first, second and changed-revision runs.

## Compare wake and idle cost

Read `containerUsage` before and after an unviewed session reaches idle sleep,
and again after a viewed wake. Compare wake counts, awake minutes and idle
sleeps for the same interval. Interrupted platform windows are estimates
bounded by the idle timeout, not billing data. Eager wake applies to every
client; any idle-window change must use the same policy for all starts.

First compare the dependency-cache key and state on two wakes with identical
package/lock bytes, deployed image and runtime identity. The key excludes the
session, revision, wake time and instance size. #47 did not change its inputs
or the live image sources; a temporary image build tag is replaced by a digest
during deployment. A changed deployed image/runtime or dependency input can
cause a one-time miss, but the reported post-#47 miss is not attributable
without private before/after receipts. Require the next unchanged wake to hit
a successfully written receipt before interpreting dependency timings or
changing the cache key.

Phase 3 performance changes need these experiments in order; they have not
been established by local checks or enabled speculatively:

- Compare `TIMDS_LIVE_INSTANCE_TYPE` sizes on a cache hit using
  `wakePhases.dependencies` and `wakePhases.total`, then restore the baseline.
- If extraction remains dominant, compare a single streamed archive, lighter
  compression and image-baked toolkit dependencies individually. Each archive
  or image change needs its own compatibility, integrity and deployed checks.
- Clone currently selects only `main` and is single-branch, but is not shallow.
  The Artifacts protocol-v1 initial clone avoids a recorded provider pack defect;
  validate shallow history and subsequent protocol-v2 fetches before changing it.

Target a cache-hit wake below 10 seconds for the small fixture. Boot placement
and dependency extraction are platform work; no local test proves that target.

## Compare repository cold starts

First measure `repository-prepare` separately from `repository-boot`. Enable a
small `TIMDS_REPOSITORY_RETENTION_SECONDS` window (maximum 300; default 0) only
for the authorized experiment. Compare start followed by update within that
window, then repeat after expiry. Ordinary operations share one source sandbox
only while this option is enabled; publication checkouts stay isolated.
Capabilities are revoked and the outbound policy cleared between operations.
A failed operation expires immediately. Confirm cleanup, retry fencing and
cross-session serialization before retaining a default window.

Independently compare `TIMDS_REPOSITORY_INSTANCE_TYPE` with its `standard-1`
baseline. Keep changes only when latency and container cost justify them.
The target is open within roughly 10 seconds after the start response and a
similar boot saving on the next update, with a usable preview around 15 seconds.
These are acceptance targets, not measured results from this change.
