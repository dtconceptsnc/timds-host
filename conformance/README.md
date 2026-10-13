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
as required by the v1 contract. Requests, submission listing, and public CSS
use the same validating transport because toolkit 0.1.464 does not expose
client methods for those operations. All other operations call
`createHostProvider` from `@dtconcepts/timds/hosted`.

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
schema rejection, error handling, public reads without credentials, and the
write guard. It does **not** establish live-host conformance.

See [CI instructions](../docs/ci.md) for automatic foundation checks and the
manual GitHub Actions run requiring an explicit disposable fixture and named
repository secrets. No live target or credential is configured by default.

## Disposable fixture requirements

Create a **new dedicated** standalone source with the existing host's normal
provisioning flow. Do not reuse a real design system or another agent's test
source. This harness does not provision or delete sources, bypass review
gates, or directly write a database.

- Its `timds.json` name must begin `TimDS conformance` (for example,
  `TimDS conformance 69`). This is checked before source files are changed.
- It must be ready, use grouped contracts (`.timds/contract-layout.json`
  schemaVersion 1), and have a working build, preview provider, publication
  worker, and designer Request runner.
- Its owner identity must have a publisher grant for this fixture.
- A second, distinct identity needs an identity token. The owner invites it to
  the disposable draft; no publisher grant is needed for that member.
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
   and no credential. The preview disappears after the draft closes.
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
   idempotent and history survives cleanup.

Every created session is tracked for test teardown, including on failure.
Publication attempts are recorded before transport, so a lost or malformed
response cannot erase evidence of a possibly accepted write. Accepted publication
IDs are retained only when they match this fixture and a submission from this
run, and duplicate receipts are drained once before cleanup. If a publication
cannot be confirmed settled, cleanup preserves its session and any parent draft
for inspection, reports the unresolved attempt/publication IDs, and fails the
test. A `failed` publication may still retry, so that status does not authorize
closing its fork. Unrelated sessions created by this run are still closed.
Redacted JSON evidence in ignored `artifacts/<run UUID>.json`
contains operation/status counts, publication IDs/versions, phase names, and
cleanup outcomes. It never records credentials, HTTP bodies or source files.
Phase names in the evidence indicate phases entered; only `passed: true`
indicates full acceptance.

## CI and acceptance order

Run `npm test` on every change. Run `npm run test:host` against a separately
provisioned `cf dev` host and then a deployed disposable host with the
environment above. Phase 0 found no local Artifacts emulator: the development
loop still requires an explicitly configured remote disposable Artifacts
namespace. Do not mock Cloudflare publication or designer completion
to turn a live conformance failure green.

The initial production portal run is a gate for extracting the host. At the
time this harness was added, **the harness unit tests passed; production
conformance had not yet been proven**. Record a successful live run's evidence
and exact deployed revision before claiming that gate passed. The package
does not claim that missing deployment credentials, runner configuration, or
the independent #60 acceptance has been completed.
