# Repository, live runtime and Workflow extraction plan

This is a post-gate implementation plan, not host implementation or a claim that
production conformance passed. Source inspected: portal master `2b0148c`, with
the extraction branch's callback-origin change in `8900bb1`. The later audit
changes are documentation; the runtime delta from that master is the configurable
callback origin. No #60 resources were changed during this review.

## Source and ownership boundaries

Retain the existing runtime files together in a host `runtime/` directory at the
first extraction. Keeping their relative imports and Docker contexts intact
makes the functional delta reviewable. The host Worker entrypoint re-exports
the native classes; its public API remains a separate Fetch router.

| Portal source | Host responsibility and minimum adaptation |
| --- | --- |
| `cloudflare/timds-designer/repository-engine.mjs` | Copy into the trusted repository image. Preserve Git plumbing and `@dtconcepts/timds/merge`; no Worker import of child processes/fs. |
| `repository-daemon.mjs`, `Repository.Dockerfile` | Preserve port 8081 and the method allowlist. Keep image-baked toolkit `0.1.464`. Add bounded snapshot/reference transport only where a Worker otherwise has to parse full source/artifact arrays. |
| `repository-service.mjs` | Preserve `RepositorySandboxRuntime`, serialization, publication checkout identity, streamed responses, exact outbound Git policy and cleanup. Inject coordinator-backed `portalCall`. |
| `live-session.mjs`, `live-dev.mjs`, `agent.mjs`, `policy.mjs`, `Dockerfile` | Copy orchestration and controlled image programs. Inject coordinator callbacks; preserve byte decoding, cold restore, Request recovery, HMR policy and sanitized diagnostics. |
| `index.mjs` | Reuse `RepositorySandbox`, `LiveSession`, `DesignerSandbox`, `Outbound`, `RepositoryOutbound` and service-only `LivePreview`. Replace same-Worker `env.LIVE/REPOSITORY/SANDBOX` calls with native `ctx.exports` lookups. Do not expose the old management handler as an unauthenticated public route. |
| `server/design-system-repository-rpc.mjs` | Extract capability preparation/completion/release into `src/repository/control.ts`. Keep a streamed-response path and a bounded JSON-result path separate; replace HTTP runner calls with native DO calls. |
| `server/design-system-live-sessions.mjs` | Preserve exact source/session ownership, fork subscriptions and read-only live credentials. Replace runner HTTP with the native live DO; keep owned preview-host provisioning as a control-plane adapter. |
| `server/design-system-designer.mjs`, `design-system-designer-requests.mjs` | Preserve authorization, exact Request binding, completion and public views. Replace portal observations/jobs/principal lookup with coordinator Request rows and host authority. |
| `server/design-system-publication-steps.mjs` | Retain step sequencing/identity rules, replace large-array helpers with snapshot references, inject public URL building, split `release` from `flip`. |
| `design-system-submission-publish-worker.mjs`, `design-system-publication-artifacts.mjs` | Port controlled toolkit/check/output validation into isolated container services and R2 adapters. Do not import the Node Docker/filesystem adapters into the Worker. |

Runtime npm dependency: `@cloudflare/sandbox@1.0.0`, using `Files` and
`SandboxFileError` plus `ctx.container`. This code already uses the native API;
it does not need a conversion to the old `getSandbox()` API. Retain host
`cf@1.0.0-beta.14` and its proven Vite plugin pin. The live image presently uses
Node 24, Git, bash, ripgrep, sandbox shim `1.0.0` and Codex CLI `0.156.1`; the
repository image has Node 24, Git, shim `1.0.0` and toolkit `0.1.464`.

Native configuration follows the deployed [Phase 0 proof](phase-0.md): one
`defineContainer({schedulingPolicy:'durable-object', images: ...})` per runtime
class; `exports.durableObject({storage:'sqlite', container})` connects each
class. Retain image keys `agent` and `repository` because runtime code selects
`container.images.agent` / `.repository`. Use
`ctx.exports.RepositorySandbox.getByName(operationId)` and
`ctx.exports.LiveSession.getByName(sessionId)` for same-Worker calls. Explicit
self-bindings to container DOs are rejected as external bindings by beta.14.
Workflows use the separate export and binding configuration validated in the
[configuration spike](cf-config-surface.md).

## Coordinator interface needed before extraction

The repository controller needs `getSource`, `get(sessionId)`,
`getSubmission`, `submissions(sessionId)` and a durable lifecycle-operation
lookup. Replace `getExecutionJob` and Supabase lease checks with the host's
stored operation/attempt/fencing identity. Never accept caller-supplied source,
fork, target-draft or submission rows as authoritative.

Preserve `repositoryControl({operationId,coordinatorId,source,method,args,phase})`
with `phase` equal to `prepare`, `complete` or `release`. Prepared plans contain
authoritative `source`, sanitized `args`, optional `previewOrigin`, and at most
four exact repository capabilities. Each capability has namespace, repository,
remote, permission, token ID and a five-minute token. Tokens enter only Worker
outbound interception properties, never the daemon payload, image environment,
DO storage, logs or Workflow receipts. Release must remain possible after grant
loss; cleanup cannot depend on new-write authorization succeeding.

The required method set is `provisionFiles`, `readSource`, `removeSource`,
`start`, `snapshot`, `stale`, `submit`, `update`, `mergeIntoDraft`, `history`,
`close`, `merge`, `preparePublication`, `commitSource`, `stagePublished`,
`pushMain`, `pushPublished`, `releaseCheckout`. `history` and `removeSource`
are resolved in the controller; the daemon intentionally has a smaller set.

All six runtime callback actions must have equivalent internal dispatch:
`complete`, `pushed`, `live-credentials`, `live-state`, `repository-control`,
`expired`. Both runtimes already accept an injected `portalCall` returning a
Response, so preserve that seam while routing trusted native calls to the
coordinator. Keep the HTTP callback adapter for the configurable standalone
runner boundary, including its runner authentication and redirect refusal.
The coordinator must not hold a non-reentrant operation lock while awaiting a
runtime call that calls it back. Expiry already avoids holding the live task
lock across its close callback; preserve that property.

## Latest-master behavior that must survive

* **Request identity and recovery (`3bb8f36`, `e769692`).** A shared session's
  ready dev server is not a Request completion. Return a runner only when its
  `requestId` matches; otherwise use that Request's saved submission receipt.
  Completion passes the original Request ID and persisted prompt/note. The
  exact temporary 409 message `This session is busy; retry when its current
  operation finishes` reschedules completion; ordinary 409 retains real
  conflicts. `retryCompletion` is internal, requires the same UUID, a conflicted
  result with no real conflicts, a still-running container and saved successful
  result, and may be used once. It replays the saved change set rather than
  rerunning the model. Reauthorize the Request/session/source on every callback.
* **Binary performance (`88bfc95`).** `cat-file --batch-check` bounds logical
  file/snapshot sizes before reading bodies. `--batch` is parsed by byte counts,
  not newline splitting or UTF-8 decoding. Blob caching is scoped to one
  checkout; repeated blob paths still count toward the logical limit. Reuse
  existing blob OIDs during merge and use one NUL-framed `update-index
  --index-info` call. Retain mode and symlink validation on cached bytes.
* **Cold main restore and incremental protocol (`471756b`, `3f99701`).** The
  proven cold command is `git -c protocol.version=1 clone --branch main
  --single-branch -- <remote> /workspace/repo`. This avoids a fork's historical
  default HEAD. Incremental sync is `git -c protocol.version=2 fetch --no-tags
  origin main`, then reset to `origin/main`. Do not change both commands to v2
  or revert incremental fetch to v1. The repository engine itself does not
  override protocol negotiation. Native Sandbox stdout/stderr may be bytes.
* **HMR policy (`96535d5`).** Only valid `timds.json` `live.strategy:'hmr'` plus
  bounded literal `restartOn` opts into native refresh. Package/lock/manifest/
  framework config changes still restart. Non-opted-in sources retain restart
  behavior; generated contract output does not cause restart loops. Refresh
  waits for readiness and advances the reload generation. Keep watcher cleanup,
  startup timeout and bounded, redacted status output.
* **Direct push refresh (`e82dc8e`).** After an accepted `main` push to the exact
  session fork, the trusted daemon posts a two-field, credential-free receipt
  to `https://timds-repository.internal/fork-pushed`. The gateway validates its
  broker-approved mutation target, write permission, exact path/method and a
  1 KiB body ceiling, then schedules live refresh with `waitUntil`. Do not await
  the target DO lock from inside the repository call. Notification failure
  cannot misreport an accepted push. The independent Artifacts Queue remains
  the durable fallback; exact synced revisions coalesce, active Requests defer
  pushes, and unknown/reordered events reconcile current main.
* **Lifecycle/diagnostics.** Retain finite expiry, nonexpiring draft cleanup
  retries, ten-minute live idle timeout, 20-minute repository checkout alarm,
  truthful sleeping/starting/ready/failed states, fixed command failure labels,
  and exact ownership checks before removing tokens/forks/previews. Acceptance
  controls and diagnostics stay internal. The VPS temp-directory changes in
  `471756b` are not host runtime dependencies; each container gets its own
  bounded workspace/temp space.

## Large payload boundary and Workflow adaptation

The current repository gateway is a Node caller: its unconditional
`response.json()` must not be copied into a Worker for source/snapshot methods.
The runtime already streams those responses and keeps its container alive
until drain or cancellation. A 50 MiB logical snapshot expands to about 67 MiB
of base64 before JSON/object overhead. Publication `preparePublication` returns
two file arrays and `commitSource` returns another. Those cannot become native
RPC values or Workflow state.

Keep streaming the unchanged public API responses. For internal publication
work, add opaque source/artifact references with small manifests and bounded
per-file/chunk transfer. Stream bytes from the container into R2 through the
trusted Worker; read them back into the next container through a fixed internal
route bound to the same publication/attempt and permitted object keys. The
untrusted build receives bytes, not R2 credentials or a general R2 proxy.
Do not implement the new R2 adapter as `get(ref).json()` over the old whole-array
JSON format. Existing ordered 8 MiB base64 `stagePublished` fragments remain a
safe bridge for individual artifacts while this reference transport is added.
Keep source limits of 10 MiB/file, 50 MiB/tree and 4,000 entries; output limits
are 12,000,000 bytes/file, 80,000,000 total and 2,000 regular files.

Implement `PublicationWorkflow` only after coordinator reservation/receipts
exist. Use publication UUID as instance identity and the seven stages in
[architecture](../architecture.md): preflight, merge, build, prepare, release,
flip, close. Pin `releasePreparedAt` before the first merge; preserve exact
source/submission/parent identity and `publication:<id>:source:<parent>` refs.
On retry, reconstruct a credential-free checkout from saved source identity;
never carry a live checkout handle between Workflow steps.

Keep pure Git/merge in RepositorySandbox. Move Node-oriented trusted toolkit
release/stamp helpers into an image-controlled service. Run source build/check
in a separate credential-free container with internet disabled. The current
Node builder's networked `npm ci --ignore-scripts` is not the required offline
cache: add controlled dependency prefetch/cache provisioning separately and
key it by lock digest, platform, Node ABI, image, flags and toolkit version.
Cache miss must be an explicit state, never implicit build internet access.

`release` records exact Git pushes and immutable R2 bytes. `flip` asks the
coordinator to recheck the live grant/fence and atomically record pointer,
generation, publication receipt and audit outbox. Only then does `close` clean
owned resources. Each external effect needs its own replay receipt because a
Workflow step can repeat after an interrupted response. Missing staged bytes
or changed identity fail recovery rather than silently rebuilding new bytes.

## Implementation order and verification

1. Once production conformance is green, agree coordinator store/fencing and
   internal dispatch interfaces; copy runtime and native export wrappers.
2. Port the Artifacts controller and repository transport, preserving capability
   release and binary streaming. Run existing Git/merge and broker tests.
3. Connect live callbacks, exact Requests and push Queue/direct delivery; run
   copied live/Request/process/HMR tests and disposable cold/warm acceptance.
4. Add bounded R2 snapshot transport and isolated offline builder/cache, then
   seven-stage Workflow using coordinator receipts. Test interruption after
   every external effect, stale CAS, permission loss before flip, midnight
   retries, failed named checks and cleanup after committed publication.
5. Run the same external v1 conformance suite against the isolated host, then
   host-specific security/concurrency/recovery acceptance before cutover.

Read-only baseline verification on the extraction branch: **91 tests passed**.
The 40 broker/live/Request/callback tests passed in 1.26 seconds; the 51 real
Git/daemon/publication/process/HMR tests passed in 50.7 seconds. The large-source
case submitted 41 MiB / 347 files in 8.66 seconds using 56 Git processes,
including transport internals. This verifies the inspected baseline, not an
extracted host implementation. Exact commands:

```sh
node --test server/design-system-repository-rpc.test.mjs server/design-system-live-sessions.test.mjs server/design-system-designer-requests.test.mjs server/design-system-designer-callback.test.mjs
node --test server/design-system-session-repository.test.mjs server/design-system-submission-publish.test.mjs server/design-system-designer-process.test.mjs server/design-system-live-dev.test.mjs
```
