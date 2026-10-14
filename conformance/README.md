# TimDS host v1 conformance

This standalone Node test package exercises the versioned HTTP contract with the
published **`@dtconcepts/timds@0.1.464`** client. It lives in the host repository
at `conformance/`. It neither imports portal implementation code nor substitutes a
fake host for deployed acceptance.

The exact OpenAPI 3.1 contract from portal
[commit `2b0148c`](https://github.com/dtconceptsnc/toperator/commit/2b0148c70b363967ad0ea2eda092f7d0b442b93b)
is vendored at the repository's
[`docs/api/timds-host.openapi.json`](../docs/api/timds-host.openapi.json), the
single authoritative spec used by this harness. Ajv's JSON Schema 2020-12 validator checks
response status, media type, required response headers, nested schemas,
formats, and error responses on every request. Unknown fields remain allowed
as required by the v1 contract. Requests, submission listing, the source event
feed, and public CSS use the same validating transport because toolkit 0.1.464
does not expose client methods for those operations. Other HTTP operations call
`createHostProvider` from `@dtconcepts/timds/hosted`.

The [designer MCP surface](../docs/api/designer-mcp.md) is exercised through a
separate MCP transport against `/api/timds/mcp` using the same fixture and
credentials. Its contribution receipts are checked alongside the HTTP flow;
anonymous `/mcp` is checked on the publication's public origin. The harness
does not require a local toolkit MCP server.

The host has since extended the vendored contract additively with
`GET /api/timds/design-systems/{source}/events?after=<seq>&limit=<n>`
(`getSourceEvents`, schema `EventFeed`) and an optional per-source `seq` on
`Event`. Existing paths and response fields are unchanged.

The contract also documents the live feed: `POST
/api/timds/design-systems/{source}/feed/tickets` (`createFeedTicket`, schema
`FeedTicket`) and the ticket-authorized WebSocket upgrade
`GET /api/timds/design-systems/{source}/feed` (`openSourceFeed`, 101). The
harness does not open WebSockets; the feed is accepted on the deployed host.

This pin includes the public preview CSS GET/HEAD `Cache-Control: no-store`
contract correction from [portal PR #89](https://github.com/dtconceptsnc/toperator/pull/89).
The sync changes only those two header constants; API v1, paths, operations and
response schemas are unchanged.

## Install and validate the harness

```sh
cd conformance
npm ci --ignore-scripts
npm test
```

The unit suite checks real toolkit request dispatch, version/auth headers,
schema rejection, error handling, public reads without credentials, the MCP
transport, the write guard, and the separate lifecycle teardown guard. It does
**not** establish live-host conformance.

See [CI instructions](../docs/ci.md) for automatic foundation checks and the
manual GitHub Actions run requiring an explicit disposable fixture and named
repository secrets. No live target or credential is configured by default.

## Disposable fixture requirements

Create a **new dedicated** standalone source with the existing host's normal
provisioning flow. Do not reuse a real design system or another agent's test
source. The `test:host` flow does not provision or delete sources, bypass review
gates, or directly write a database. The separately acknowledged `test:lifecycle`
flow below creates and deletes its own new fixture.

- Its `timds.json` name must begin `TimDS conformance` (for example,
  `TimDS conformance 69`). This is checked before source files are changed.
- It must be ready, use grouped contracts (`.timds/contract-layout.json`
  schemaVersion 1), and have a working build, preview provider, publication
  worker, and designer Request runner.
- Its owner identity must have a publisher grant for this fixture.
- A second, distinct identity needs an identity token and must have no publisher
  grant on the fixture. The owner invites it to the disposable session and draft;
  this member proves that contributor checks do not require publication rights.
- Both credentials must permit authenticated MCP contribution. OAuth bearer
  tokens need `timds:read` and `timds:write`; scopes do not replace the fixture
  grants above.
- There must be no other open sessions or drafts on the fixture. No other
  process may write it during the run.
- The host URL, immutable source ID, and immutable system ID must be selected
  explicitly. HTTPS is required except for localhost development.

Supply these environment variables using your secret manager or CI secrets:

| Variable | Value |
| --- | --- |
| `TIMDS_HOST_URL` | Host origin, e.g. `https://timds.com` or `http://127.0.0.1:8787` |
| `TIMDS_FIXTURE_SOURCE_ID` | Disposable source UUID |
| `TIMDS_FIXTURE_SYSTEM_ID` | Its exact system ID, e.g. `timds/<uuid>` |
| `TIMDS_ALLOW_DISPOSABLE_WRITES` | Exact `<source UUID>:<system ID>` acknowledgement |
| `TIMDS_ACCESS_TOKEN` | Owner/publisher identity credential |
| `TIMDS_MEMBER_PRINCIPAL_ID` | Second identity's principal UUID |
| `TIMDS_MEMBER_ACCESS_TOKEN` | Second identity's distinct credential |
| `TIMDS_CONFORMANCE_TIMEOUT_MS` | Optional timeout per async operation; default 900000, maximum 3600000 |

```sh
npm run test:host
```

An absent credential or fixture selection **fails**, rather than silently
skipping a live test. `TIMDS_ALLOW_DISPOSABLE_WRITES=true` is deliberately
insufficient. No default target points at production. A configured run performs
real writes, creates billable previews/Requests/builds, publishes two versions,
rolls back to the first, and restores the second. The fixture retains those
published audit records and files for inspection. Delete it through the host's
ordinary approved lifecycle after examining the results.

## What the live run proves

1. Explicit source access and publisher grant; start idempotency and pull.
2. Nonexpiring named drafts, draft listing/snapshot, a real second-principal
   invitation/join, advisory claim overlaps, stale-revision rejection, and
   stale-hash rejection even when the base revision is current.
3. Two children editing different keys in one JSON file merge cleanly into a
   shared draft. A third editing the same key receives
   `{path,key,base,mine,theirs}`; explicit revision-bound resolution works.
   Rejected writes leave the fork unchanged.
4. Status and retained history carry members, principal IDs and intent notes.
5. Public CSS GET/HEAD expose the draft token value, cache/CORS/noindex headers,
   and no credential. Ordinary draft closure cascades to its three still-open
   children, retaining their histories and one close event each. The parent
   and children leave active work; the draft leaves its list and public CSS
   disappears. Close retries remain idempotent. Closed children refuse source
   reads and edits, closed drafts refuse new child sessions, and both refuse
   new designer Requests.
6. Two main submissions are frozen idempotently. A dry run checks the build
   without closing the session. FIFO acceptance positions and completion order
   produce consecutive dated `YYYY.MM.DD-N` releases (including UTC day rollover).
   Both frozen submission Previews must serve HTML before publishing. Published
   sessions close; history remains. Anonymous current/pinned publication stamps
   prove that rollback selects the older immutable version, keeps pins unchanged,
   and restores the new version; dry-run leaves the public pointer untouched.
7. A real designer Request, retried with the same request ID, produces a frozen
   submission with the original instruction and exact requested file bytes. It
   has no publication and leaves the public pointer untouched. Session close is
   idempotent and history survives cleanup. Exact HTTP and MCP POST replays of
   the succeeded Request return its original execution identity after closure,
   without creating a session or reopening the target. Replays with a changed
   prompt or target return 409. Request GET retains its succeeded status and
   original completed submission receipt.
8. The event feed rejects invalid cursors with 400, and every walk from a
   cursor returns consecutive `seq` values that replay identically. It records
   `draft_created`/`session_started`, `member_joined` (including the invited
   member), `claimed`, `updated` and `closed` for the run's sessions. Each
   publication has `publication_queued`, one `publication_stage` per Workflow
   stage (`preflight`, `merge`, `build`, `prepare`, `release`, `flip`, `close`)
   and `published`, which commits during `flip`. The designer Request records
   `request_received` once (despite the retry), then `member_joined`,
   `request_started`, `request_submitted` with its submission ID and
   `submitted`, and no `request_failed`. `active-work` events carry `seq`.
9. Authenticated MCP discovers the fixture, starts and recovers a session,
   lists and reads authored files in bounded pages, invites the second member,
   returns a credential-free Studio join link, and closes sessions and drafts.
   Its draft file reads, claims, stale-update guards, main submission and retry,
   publication preflight/build check, publication/polling and designer Request
   creation/polling agree with the HTTP flow. Guarded MCP rollback rejects an
   obsolete current version, reuses its durable receipt, and never reapplies an
   old rollback when retried after HTTP restores the newer release. Anonymous
   `/mcp` exposes published reads without contribution tools.
10. MCP describes the authored workspace and bounded media catalogue, rejects
    protected tooling, grouped token aggregates, agent configuration and new
    symbolic links, and leaves source bytes unchanged after those refusals.
    The member without a publisher grant runs a controlled check of the clean
    initial fixture, reads its receipt and bounded private derived output, and
    recovers the same completed check on retry. The check creates no submission
    or publication. A later authored edit marks its receipt stale without
    silently rebuilding under the old check ID; check history survives closure.

Every created session is tracked for test teardown, including on failure.
HTTP and MCP publication attempts are recorded before transport, so a lost or malformed
response cannot erase evidence of a possibly accepted write. Accepted publication
IDs are retained only when they match this fixture and a submission from this
run, and duplicate receipts are drained once before cleanup. If a publication
cannot be confirmed settled, cleanup preserves its session and any parent draft
for inspection, reports the unresolved attempt/publication IDs, and fails the
test. A `failed` publication may still retry, so that status does not authorize
closing its fork. Unrelated sessions created by this run are still closed.
Publication completion polling also permits the host's ordinary retries to
recover a `failed` or errored `closing` receipt, while still requiring final
`published` status before the deadline and every FIFO/version/pointer assertion.
Observed failure states, stages and timestamps remain in redacted evidence;
the harness does not trigger retries or retain free-text host errors.
Redacted JSON evidence in ignored `artifacts/<run UUID>.json`
contains operation/status counts, publication IDs/versions, phase names, and
cleanup outcomes. It never records credentials, HTTP bodies or source files.
Phase names in the evidence indicate phases entered; only `passed: true`
indicates full acceptance.

The ordinary-close assertions reuse only the parent, children and Request
session already owned by this run. They exercise successful closure and
closed-target refusals. They do not inject a cleanup crash or force a Request
to remain queued during closure; recovery after interrupted cleanup and
pending-job cancellation still require their separate deployed checks.

## Native creation and teardown acceptance

`npm run test:lifecycle` exercises the built-in starter creation API and the
[reviewed deletion protocol](../docs/lifecycle-deletion.md) on a **new** native
source. Run it only after explicitly selecting and authorizing that disposable
fixture. It requires an already active organization and already deployed
Artifacts namespace. It does not create or remove either shared resource.

| Variable | Value |
| --- | --- |
| `TIMDS_HOST_URL` | Explicit host origin, such as `https://host.example.com` |
| `TIMDS_ADMIN_ACCESS_TOKEN` | Active host administrator credential with read/write scopes |
| `TIMDS_LIFECYCLE_SOURCE_ID` | New lowercase source UUID that has never existed on the host |
| `TIMDS_LIFECYCLE_SYSTEM_ID` | New system ID beginning `timds-conformance/` |
| `TIMDS_LIFECYCLE_ORGANIZATION_ID` | Existing active organization UUID |
| `TIMDS_LIFECYCLE_NAMESPACE` | Existing deployed Artifacts namespace |
| `TIMDS_ALLOW_LIFECYCLE_TEARDOWN` | Exact `<new source UUID>:<new system ID>` acknowledgement |
| `TIMDS_CONFORMANCE_TIMEOUT_MS` | Optional asynchronous-operation timeout, with the same bounds as `test:host` |

```sh
npm run test:lifecycle
```

The lifecycle flow has no default target and cannot be enabled by the ordinary
`TIMDS_ALLOW_DISPOSABLE_WRITES` acknowledgement. It reads every administrator
catalogue page, including deleted tombstones, and refuses either identity if it
already exists. Its first write reserves a unique creation operation for that
exact acknowledged source. It verifies the separate provisioning receipt binds
the source, system, organization, namespace, repository, provider repository ID,
file digest and initiating administrator to this run before admitting teardown.

The live run proves:

1. The built-in pinned starter becomes ready, exact creation retries preserve
   its source commit and digest, and changed creation input is rejected.
2. The new source is discoverable and supports a main session, an open draft,
   anonymously readable draft CSS, and an authored frozen submission. The
   frozen Preview must serve actual HTML before deletion begins.
3. A reviewed impact receipt matches the exact native provider repository and
   only tracked session work. The run refuses imported provenance, unexpected
   publishers, Requests or media. A deliberately wrong typed repository name
   leaves the operation awaiting confirmation. The correct reviewed name/hash
   queues deletion, and completion and confirmation replay are verified.
4. Both session histories and audit descriptors survive for the administrator;
   the admin catalogue retains the deleted identity. Ordinary discovery,
   session snapshots, new authoring, draft CSS and the frozen Preview become
   unavailable. Reusing the original creation operation or reserving the same
   retired identity under a new operation fails.

The fixture remains exclusive to this run until teardown finishes. Failure
cleanup independently rereads the exact provisioning receipt before preparing
and reviewing a deletion; it never adopts an existing source or repository by
name. If ownership cannot be proved, extra work appears, or an already confirmed
cleanup pauses, the run fails and retains the operation IDs for operator review.
It does not bypass the host's guards or automatically resume failed destructive
steps. Redacted evidence is saved to ignored
`artifacts/lifecycle-<run UUID>.json`, with credentials and source bytes omitted.
Only `passed: true` means the whole lifecycle run passed.

This run creates billable forks and a Preview. It does not publish an immutable
release or create a designer Request or media upload; those surfaces retain
their separate acceptance requirements. Local harness tests establish the
guards and contract handling only. A deployed lifecycle run is still owed until
the complete run above is observed.

## CI and acceptance order

Run `npm test` on every change. Run `npm run test:host` against a separately
provisioned `cf dev` host and then a deployed disposable host with the
environment above. Phase 0 found no local Artifacts emulator: the development
loop still requires an explicitly configured remote disposable Artifacts
namespace. Do not mock Cloudflare publication or designer completion
to turn a live conformance failure green.

The initial production portal run is a gate for extracting the host. That
baseline passed on October 13, 2026 (private operational record),
with the exact deployed revision and redacted machine receipt recorded there.
The new host still requires its own local and deployed runs. This receipt does
not claim completion of the independent #60 acceptance or production migration.
The MCP extension has not been accepted merely by passing this package's local
unit suite; its authenticated deployed run is still owed.
