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

Local validation uses real SQLite adapters for reservations, lease takeover,
bounded retries and durable receipt recovery, with explicit native RPC tests:

```sh
node --test test/requests/requests.test.mjs test/live/sessions.test.mjs
```

These tests do not establish deployed host conformance. The production portal
baseline passed; the standalone host still requires `cf dev` and deployed
execution of the complete conformance harness.
