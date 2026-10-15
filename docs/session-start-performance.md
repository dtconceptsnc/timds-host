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
   starting-session reads rehash the pinned tree for each call. Keep this path
   if the small fixture responds within a couple of seconds; consider caching
   file metadata by `start_revision` only if reads are slower than waiting for
   `open`.
3. Replay start with the same key and origin; require the same session and
   pinned revision. A changed origin must fail. Record an immediate update
   and submit separately, including any 409 and elapsed wait. The write wait
   is bounded at 45 seconds, based on the recorded approximately 25-second
   cold fork, and is subject to measured confirmation after deployment.
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

Also accept a source over the direct-read limit and one with a safe symlink:
both keep the container fallback and all file/byte limits. Their fork is part
of the blocking start path, so the small-tree overlap target does not apply.
Test expired/revoked starts, exhausted retries, an explicit start retry,
close during either live lease, and deletion during host work. Refusals must
leave no unauthorized checkpoint or newly orphaned resource.

## Compare wake and idle cost

Read `containerUsage` before and after an unviewed session reaches idle sleep,
and again after a viewed wake. Compare wake counts, awake minutes and idle
sleeps for the same interval. Interrupted platform windows are estimates
bounded by the idle timeout, not billing data. Eager wake applies to every
client; any idle-window change must use the same policy for all starts.

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
