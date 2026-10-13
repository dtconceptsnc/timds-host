# Publication dry-run execution

This receipt concerns only disposable source `6ffb48ea-862e-42de-9303-5edcbe8829d5`,
system `timds/cf-preview-source-proof`, and original submission
`189cf3bd-5082-4c9e-8a47-f74094139f83`. No actual publication is authorized by
this debugging command. The operation is the real toolkit `publish --dry-run`,
using the existing privately stored OAuth credential; no new test harness was
created for this work.

On October 13, 2026, native metadata diagnostics identified a `TypeError` at
outbound binding setup. The generated `ctx.exports` callable signature requires
an options object. Build entrypoints now receive `{props:{}}`, like the proven
repository/live entrypoints. Native build successes retain their original return
shape across deployments. Failures carry only allowlisted operation/stage/class
identifiers; callers also validate returned file-tree receipts before use.

Subsequent attempts failed before metadata with Artifacts REST HTTP 403/code
10004 at `repository-read`. On deployment
`5be68cf7-443b-4ec9-b1ea-a1f940de0a1e`, private SHA-256 comparisons confirmed
both the effective runtime credential and full repository API URL were identical
to the immediately successful local HTTP 200 request. Only equality booleans
were emitted. This rules out a stale runtime credential or a different repository
URL for that attempt; it does not establish Cloudflare's reason for treating the
Workers-origin request differently. The temporary fingerprint fields were then
removed from source and the following deployment.

Deployment `a8107924-c424-4dde-bc31-c6f2663a9b3a` replaces this runtime REST path
with the native Artifacts binding for the explicitly configured namespace
`timds-host-69`. The binding adapter preserves provider repository IDs, uses
short-lived repo-scoped Git capabilities, revokes through the exact repository,
and disposes every RPC handle. No expiring managed OAuth is needed for these
runtime repository calls. Existing dedicated Builds credentials now authenticate
the remaining Workers/Preview/event-subscription REST calls. Unconfigured
namespace access fails closed; REST fallback requires explicit configuration.

Both ordinary and namespace-configured type generation/typecheck passed, and
the actual cf build completed. The original dry-run then returned HTTP 200 in
198.481 seconds on this deployment. Its receipt is
[`publication-dry-run-receipt.json`](publication-dry-run-receipt.json):
`dryRun: true`, `buildChecked: true`, `currency: clean`, `autoRebased: false`,
version `2026.10.13-2`, and unchanged main revision
`08bbc06409ca1a6ef9f27828151b4479c8c58b4e`.

This completes real native binding access, metadata preparation, release commit
in an isolated checkout, dependency preparation, offline publication build,
stamp validation, and checkout cleanup. It also proves the corrected native
outbound setup reaches completion. The generated build passed the host's normal
checks without bypasses or altered source data. No actual publication, public
pointer change, source-main push, or migration was performed by this dry-run.
Actual publication/rollback and the remaining host acceptance belong to the
next explicitly coordinated step.

## Actual publication cleanup diagnosis

The subsequent operator-owned actual publication
`f38e6324-030a-4d02-aa26-6c24e0104fc6` committed its public pointer and then
reported `Publication close failed`. Read-only inspection found its session
`closing`, live state `closed`, empty sandbox ID, deleted review Git branch, and
still-present session fork. The deployed repository engine's `close()` returned
`undefined`; the reference-transport daemon then dereferenced `result.files`
before its successful-completion callback. This matches the observed partial
cleanup exactly.

The local correction returns an explicit close receipt and normalizes void
transport results. Cleanup accepts only the matching publication, source,
session, and submission with an existing durable pointer event. Post-commit
Workflow failures retain `closing` and their cleanup error, so normal retries
cannot reclassify the committed publication as an uncommitted failed release.
Provider readiness codes now retry as HTTP 503. Primary operation diagnostics
survive secondary checkout/lease/container cleanup failures.

Repository capability cleanup now records only source/operation identities,
repository provider IDs, token IDs, and expiry bounds in the native object's
durable storage. Alarms retry exact-capability revocation; receipts distinguish
confirmed revocation from elapsed capability expiry. Uncertain revocation does
not produce a clean successful response. It never stores token values or source
files. These follow-up changes await the next coordinated deployment and exact
publication recovery; this section is not a successful-cleanup receipt.
