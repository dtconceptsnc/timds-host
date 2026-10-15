# Requests and native live sessions

`createHostRequests` assembles source-local SQLite Request jobs, the API v1
Request service, the native designer adapter and live callbacks. It takes the
already constructed session domain and authorization facade. It does not
authenticate HTTP callers, select a source from request bodies, or publish.

The edge supplies an authenticated actor to `create(actor, sourceId, body)` or
`read(actor, sourceId, requestId)`. The coordinator durably schedules an alarm
after creation. `requestStore.claim` supplies a finite lease; `execute` checks
that lease, current caller authority and the immutable Request bindings before
dispatch. Execute runs outside the coordinator queue; injected `runMutation`
serializes session start/join and the final job checkpoint, while native model
start stays outside so its credential callback can complete. Failed dispatch
uses `requestStore.fail`; attempts are bounded and
the same authorized Request POST can retry a terminal job. `nextAlarm()` must
participate in the coordinator's next-alarm calculation, including delayed
retries and leased work that can outlive an isolate.

Untargeted designer Requests use the session domain's internal synchronous
start option. Normal API starts may return the pinned source tree while their
fork and live preview are pending; a Request dispatch needs the fork and live
runner before it can begin model work. The synchronous option keeps that
dispatch ordering and the same idempotency key, authorization and session
lease checks. It is not exposed as an API request field.
Requests targeting a starting session first wait up to 20 seconds for its
fork outside the coordinator mutation queue, then recheck the session before
dispatch.

Closing a session or draft cancels its bound queued, leased and running
dispatch jobs, including the Request that created an untargeted session. The
session closing hook calls the Request store directly inside the existing
coordinator mutation queue; it must not recursively enter that queue. Each
cancellation clears the job lease and records `request_failed` with status
`cancelled`, so a delayed dispatch cannot finish or requeue the cancelled job.
Already completed dispatch receipts remain retained; closing the live runtime
stops any model work still running behind them. Child session jobs are cancelled
as draft cleanup reaches each child.

New Requests and POST retries that would dispatch work to a closing, closed or
expired session return 410 before reserving or scheduling work. An exact POST
replay of an already-succeeded job returns the original acceptance receipt even
after the target closes, without scheduling it again. Current source, principal
and target authority still apply, and the reservation validates every immutable
input before returning that receipt. A terminal untargeted job cannot be retried
once its bound session closes. Read the existing Request for its durable status;
completion recovery of an already-dispatched Request still checks current caller
authority and exact submission identity.

D1 reserves each Request UUID globally before the coordinator inserts its
Request and job in one SQLite transaction. The reservation preserves source,
requester, prompt and target session, with an agent principal selected by the
server at first reservation. Repeating a Request after configuration rotation
retains that original agent. The original human and persisted agent must still
be active and authorized at completion; callback bodies cannot select them.

A lost native-start response can arrive after the model finishes and its fork
closes. Execution recovers an exact submitted audit event plus its matching
frozen submission before attempting to join an open fork. It still checks the
original caller's authority. This recovery neither reruns the model nor marks
unrelated work complete. Shared live-server readiness and another Request's
task state never stand in for this Request's receipt.

`createHostLiveSessions` invokes `LiveSession` through native RPC. Configuration
persists the source UUID alongside the session UUID. Fork credentials are
read-only, expire after 15 minutes and remain transient in native runtime input
and outbound interception props; Request/job/session rows never store them.
Live host provisioning checks exact ownership tags before changing a Worker.
Artifacts subscriptions require exact namespace, fork, destination and event
identity before reuse or cleanup.

The native callback path is binding-only. `live-credentials` and `live-state`
can occur while `LiveSession.start` is waiting, so they cannot wait behind the
same coordinator operation's serial queue. `complete` and `expired` retain
the normal serialized, lease-checked mutation path. The runtime checks its
persisted session identity; the callback factory also checks coordinator source
ownership. The edge must not expose this capability as an unauthenticated HTTP
route.

Request transitions append source feed events with `originating_request_id`
and `details_json.requestId`: `request_received` with the reservation,
`request_started` once the runner accepts the Request, `request_submitted`
in the same transaction as (and just before) its `submitted` event, and
`request_failed` on a job failure or dead letter, a completion conflict, or a
runner `failed` state. `live-state` may name the runner's current Request; the
callback attributes it only when that Request is bound to the same source and
session. Errors in these rows are host-authored safe messages and sanitized
diagnostics, never model output or credentials.

Requests that name a session or draft run one at a time, in arrival order
(`created_at`, then job id). `due()` offers only the oldest pending job for each
target session and skips it while another job for that session holds a live
lease, or while the session's last runtime `live_state` is `running` (a report
older than 15 minutes no longer holds it). `nextAlarm()` counts only those head
jobs; a runner-held session contributes a one-minute fallback, and the
`ready`/`failed`/`sleeping`/`closed` live-state callbacks re-arm the alarm within a
second when a job is due. If dispatch still meets a busy runner (the designer's
pre-check or the runtime's 409 "Another Request is running in this session"),
`execute` calls `requestStore.requeue`: the job returns to `queued` with
`available_at` 5 s ahead, its `attempt_count` restored and no `request_failed`.
Real failures keep `fail` and dead-letter after `max_attempts`. Requests that
start their own session are not ordered. The Request read returns
`targetSessionId` and `queuePosition`: 0 when running, finished or next, else the
number of Requests ahead including the one whose runner holds the session.

Before `request_started` the designer claims its intent once per Request as an
advisory `claimed` row: the paths of the session's latest submission diff when
1–100 safe paths exist, otherwise `tokens.json`, `tokens/**`, `src/**`, with the
prompt's first 200 characters as its note. An identical existing claim is not
rewritten. `presence(view)` adds `runner` (`LiveSession.status()` only; no
container start) and `queueLength` to `active-work` and session `status` views.

Sessions sleep: `LiveSession` destroys its container 10 minutes after its last
activity, unless a feed viewer still watches it (`watch`, see "Warm drafts and
wake" in `docs/architecture.md`). A Request to a sleeping session is not
delayed or refused. After its busy check, the designer writes `live_state`
`waking` when `LiveSession.status()` says `sleeping`, and the runtime's
`start()` wakes the container (clone, dependency restore or `npm ci`, dev
server; see "Live dependency cache" in `docs/architecture.md`) before running
the model. The runtime then reports `starting`, then `running`, then `ready`. If
the start fails before the runtime is called, the designer writes `sleeping`
again, so the session is never left showing `waking`. A viewer opening a
sleeping session gets the same `waking` row and a `LiveSession.resume()`, which
wakes from the session's own alarm. Neither path waits for the container in the
coordinator's writer queue.

Local validation runs the repository's smoke checks:

```sh
npm run typecheck
npm run build
npm test
npm run check:docs
npm run check:boundary
```

These checks do not establish deployed Request behavior. A fresh designer
Request, a Request targeting a newly started session, and the complete
conformance harness still require acceptance on an explicitly authorized
deployed host with a disposable source.
