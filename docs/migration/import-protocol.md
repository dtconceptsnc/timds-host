# Inactive portal imports and ownership activation

Implementation is prepared; migrations `0002_imports.sql` and
`0003_deleted_imports.sql` have **not** been applied
and no production import or activation has run. The cutover operator must still
read the actual portal freeze/quiescence journal and perform source-by-source
acceptance. This API never infers identity from email, adopts an existing
repository by name alone, or creates provider write credentials.

## Routes and durable state

All routes require a current host administrator. They enter the same source
coordinator mutation queue used by publication and grant mutations.

| Method/path | Effect |
| --- | --- |
| `POST /api/timds/admin/imports` | Reserve an inert source and immutable manifest |
| `GET /api/timds/admin/imports/:operationId` | Read authoritative stage receipt and received chunk digests |
| `POST /api/timds/admin/imports/:operationId/chunk` | Verify and store one bounded chunk |
| `POST /api/timds/admin/imports/:operationId/seal` | Verify frozen portal proof, complete history/pointer and outbox |
| `POST /api/timds/admin/imports/:operationId/activate` | Commit the matching portal activation intent, grants and readiness |
| `POST /api/timds/admin/imports/:operationId/abort` | Permanently forbid this import's activation |
| `POST /api/timds/admin/imports/abort-unprepared` | Permanently forbid an operation before an import/source reservation exists |
| `POST /api/timds/admin/imports/tombstone` | Reserve an already-deleted portal source as a permanent inactive identity |

D1 states are `prepared → sealed → active`, or terminal `aborted` before active.
The source remains `importing` until activation. Public reads and ordinary source
operations require `ready`. An aborted source stays `import_aborted`, and its
operation/source UUID reservation is retained; automatic reuse after a portal
thaw is intentionally unsupported. A new transfer of that source needs an
explicit designed reservation-replacement procedure, never row deletion or a new
UUID that discards original identity.

Early abort accepts `{operationId,portalSourceId,sourceId,origin,epoch,portalProof}`.
Its signed action is `abort-unprepared` and its receipt phase must be the actual
portal `freezing` or `frozen` phase. No snapshot/export/stage digest is required
before it exists. An active administrator and matching source coordinator are
still required. A durable DO marker is followed by a D1 abort tombstone; prepare
checks both, with D1 insert triggers serializing global operation conflicts.
An existing system or prepared import is rejected, so early abort cannot disable
active work. No system row is created. Retry a partial abort with the exact same
binding; readback has `stage:'aborted',hostState:'inactive',activationForbidden:true`.
The same operation can never prepare later. A different future operation after a
verified portal thaw is possible because this early path reserved no system.

Prepare accepts:

```js
{
  operationId, portalSourceId, sourceId, // all UUIDs; sourceId === portalSourceId
  epoch, snapshotDigest, exportDigest, portalProof,
  manifest: {
    schemaVersion: 1,
    portalOrigin: 'https://portal.dtconcepts.net',
    originalSource, // exact portal row, including its historical pointer
    source,         // same UUID/provenance, additive organization_id/opaque repository ID
    repository: { id, namespace, name },
    principalMap: [{ portalPrincipalId, hostPrincipalId, type: 'user', mode: 'existing' }],
    grants: [{ principalId, read: true, write: false, publish: false }],
    auditSnapshot: {kind:'point-in-time',capturedAt:'ISO timestamp',
      digests:{observations:'canonical SHA-256',principals:'canonical SHA-256',portal_profiles:'canonical SHA-256'}},
    pointer: { versionId, eventId },
    chunks: ['sha256 of canonical chunk 0', 'sha256 of canonical chunk 1']
  }
}
```

Canonical hashing recursively sorts object keys, retains array order, serializes
JSON without whitespace, and hashes UTF-8 with SHA-256. `exportDigest` hashes the
entire manifest. It therefore binds original source, host organization, exact
opaque repository ID, mappings/grants, pointer, and every chunk. `snapshotDigest` is the
separate Postgres frozen snapshot digest. Retries must retain the original actor
and complete input. The live Artifacts opaque repository ID is checked at prepare,
seal and activation. Live principal mappings and the organization must already exist.
There is no implicit grant to the importing administrator.

Active imports require the original and normalized source to be `ready` and
unarchived. Deleted or archived original sources are rejected, never normalized
into active systems. Their identity/public-404 preservation requires a separate
explicit tombstone procedure below; do not send them through active import.

## Already-deleted sources

The separate tombstone route preserves deleted Nacho identities and their public
404s. It does not provision, adopt or delete any Artifacts repository, Preview,
Sandbox or R2 object. It imports no versions, publication events, assets, grants,
principal mappings or original content. An archived but undeleted source is not
eligible for this path or active import.

Input is `{operationId,portalSourceId,sourceId,exportDigest,manifest,portalProof}`.
`sourceId` and `portalSourceId` must equal the original deleted source UUID.
The manifest has exactly `schemaVersion:1,kind:'deleted-source',portalOrigin,
organizationId,capturedAt,identity,deletion,legacyPublicRoots` (the last is null
or explicitly reviewed legacy hostname metadata). `identity` preserves the
retained portal identity's `system_id,operation_id,source_id,repo_id,deleted_at,
created_at`. `deletion` preserves the completed deletion's `id,kind,status,stage,
system_id,source_id,repo_id,owner,repository_name,artifacts_repository_id,
confirmed_at,completed_at,created_at,updated_at`. Repository provider IDs are
opaque, not UUIDs. The canonical manifest digest binds every captured field,
the original timestamps, target organization and reviewed hostnames.

The operator must read the actual retired identity and confirmed completed delete
record, verify matching IDs and source/repository absence, and reread them
immediately before signing. Absence alone, a browser assertion or an active
source row cannot authorize a tombstone. Proof action is `tombstone`, phase
`deleted`; receipt binds the operation/source/host/export digest, `capturedAt`,
canonical `identityDigest` and `deletionDigest`, `originalDeletionOperationId`,
and independently read `sourceAbsent:true,repositoryAbsent:true` facts. The
ordinary short-lived HMAC and active host administrator requirements still apply.

D1 atomically inserts a minimal `systems` row already marked `deleted` and an
immutable `import_deleted_sources` receipt. Existing source/system/repository
identities and existing transfer operations cannot be replaced. A synchronous
coordinator commit installs the completed deletion fence and minimal audit
outbox, then drains it. A crash between D1 and SQLite remains inactive; retry or
authenticated GET readback finishes the local fence/audit without external work.
Readback is `stage:'deleted',hostState:'deleted',activationForbidden:true` with
the original deletion operation/timestamp, capture timestamp and export digest.
There is no activate, abort, thaw or resurrection transition. `0003` also guards
completed native deletion identities against lifecycle reset, identity removal
and new grants, while permitting append-only audit projection progress.

This path uses the existing portal deletion tables; it needs no new portal SQL,
source ownership journal or quiescence workflow because deletion already
completed. Deploy host D1 migrations through `0003`, configure the exact HTTPS
`TIMDS_PORTAL_ORIGIN` text binding and independent
`TIMDS_PORTAL_TRANSFER_SECRET` secret binding, and use the portal driver's
explicit `tombstone-plan`, `tombstone`, `tombstone-readback` commands. Keep the
same private state and operation after any ambiguous response. Host config now
declares both proof bindings; empty/missing configuration remains closed.

Live mappings (`mode:'existing'`, the compatible default) require an already
verified host identity of the stated type. Historical people/services may instead
use explicit `mode:'archive'` with a distinct supplied `hostPrincipalId`, original
`portalPrincipalId`, `type`, and bounded display `name`. Prepare creates these
only after signed frozen-journal/manifest verification, in the same D1 batch as
the inert source reservation. Their issuer is reserved as
`urn:timds:portal-history:<portalOrigin>`, subject is the original UUID, status is
permanently inactive, and admin is false. Existing conflicting identities fail;
email/name equality never links them. Archive targets cannot receive any grant.
D1 triggers prohibit activating, changing authority/identity or granting access
to these rows. They represent audit authors and can never log in.

Global observations/principals/profile rows are an explicitly timestamped copied
audit snapshot, not falsely claimed to be covered by the source write fence.
The driver requires two matching full inventory reads during capture; the
manifest binds each audit table digest and seal recomputes them from raw history.
Retries retain that immutable captured audit. Source-bound rows and the SQL
snapshot are independently rechecked before authority changes.

The manifest is limited to 1 MiB, 10,000 chunk digests, 200 principal mappings and
100 grants. A chunk is at most 512 KiB; individual rows are at most 128 KiB.
Imports beyond these bounds fail closed rather than truncate history. Byte trees
are separately backfilled into locked RELEASES using the
[artifact backfill procedure](artifact-backfill.md).

## Chunks and immutable readback

Chunk POST body is `{position, chunk}`. Positions/digests are fixed at prepare.
The original immutable chunk is not replaced by a retry; `receivedChunks` shows
the saved positions/digests. Send parent rows before child rows.

```js
// Every legacy version row, including duplicates, receives its own chunk.
{ kind: 'version', original: originalPortalVersionRow,
  version: { ...originalPortalVersionRow, source_id: sourceId,
    artifact_ref, artifact, stamp },
  releaseManifestDigest }

{ kind: 'rows', table: 'sessions', rows: [originalClosedSessionRow] }
```

`version` must retain every original field, including `design_system_source_id`,
ID, timestamps and snapshot. Additive host fields describe the actual release.
Keep the stamp's authored property order when transmitting it: the immutable
stamp JSON bytes are verified, not rewritten. `releaseManifestDigest` is the
SHA-256 of the actual physical `.timds-release.json` bytes. Verification checks
the exact source/label/stamp and every file/stamp HEAD/checksum; when R2 lacks a
checksum the existing verifier reads and hashes the body. A durable proof records
the manifest hash, artifact reference, source commit and content digest.

Version chunks without release proof retain original history but receive no
live artifact binding. All first publication events by `(created_at,id)` require
verified releases. Later duplicate rows/events are preserved, and can carry a
live artifact only when provenance matches the original first label binding.
The current pointer must identify a verified version/event with the original
source's label, commit and content digest. Conflicting old labels or missing
immutable bytes block activation; they are never reconciled by guessing.

Live history tables are `sessions`, `members`, `submissions`, `publications`,
`events`, and `publication_events`. Sessions must be closed/expired, submissions
published/closed, publications published/superseded. Closed runtime credentials,
lease and live-state fields are cleared only in the portable view; original rows
remain in immutable `import_history`. Principal IDs are explicitly mapped in
portable rows, while originals retain historical IDs. Parent links are checked
at seal. Original audit IDs and timestamps are retained.

Original memberships keep their `(session_id,principal_id)` composite key in the
archive; the live row key uses the explicitly mapped principal. A UUID is never
invented for a membership or a publisher/identity record without one. Archive-only
rows without IDs use an internal canonical-row digest while retaining the exact
original JSON. Inviter identity is explicitly mapped in the live membership too.

Archive-only tables are `claims`, `jobs`, `requests`, `observations`,
`request_jobs`, `lifecycle_operations`, `legacy_drafts`, `legacy_draft_builds`,
`assets`, `asset_uploads`, `artifact_upload_leases`, `principals`, `publishers`,
`publisher_events`, `identities`, and `portal_profiles`.
Do not export secret values. Historical Request IDs identified by session/audit
origins or `timds_designer_request` jobs get permanent D1 tombstones. They cannot
be replayed as new Requests; the importer does not invent live host Request or
runner records. Closed session idempotency reservations are also retained.

The seal records chunk count, history count, pointer IDs and a digest of the
per-version release proofs. RELEASES is physically write-once and bucket-locked;
the final activation uses those durable per-version proofs rather than repeat
an unbounded scan of every file. No ordinary or administrator import endpoint
can mutate a sealed chunk. Deploy the release bucket lock before using imports.

For an old public hostname, the reviewed normalized source declares
`legacy_public_roots:{schemaVersion:1,behavior:'portal-public-roots-v1',hosts:[...]}`.
Every released version then needs `legacy_public` from the completed conversion:
exact first-publication event ID, physical manifest digest, original entry path,
local file paths and R2 bundle-only fallback paths/content types. Import verifies
the physical file map/hash and seal verifies the first event; it does not infer
these distinctions from the merged release tree. Optional primary
`public_root_url` must be explicitly reviewed, never inferred from hostname order.
See [legacy roots](legacy-public-roots.md). Routing/DNS remain separate operations.

## Trusted portal proof transport

Default verification is closed. Deploy `TIMDS_PORTAL_ORIGIN` as the exact portal
origin and independent `TIMDS_PORTAL_TRANSFER_SECRET` (at least 32 characters)
to the host and trusted operator process. Never send that secret to a browser or
store it in an export. OAuth and Access credentials do not substitute for it.

The operator first reads the real portal journal via authenticated backend/DB,
then calls `signPortalReceipt` from `src/imports/portal-proof.mjs`. The wire proof
is `base64url(canonicalClaims).base64url(HMAC-SHA256(secret, encodedClaims))`.
Claims bind exact portal issuer, host audience, action, receipt and 120-second
validity. Verification accepts at most 300 seconds and checks the signature in
constant time. A caller's `verified` flag has no authority.

The receipt contains `operationId, portalSourceId, sourceId, origin, epoch,
snapshotDigest, exportDigest, stageId`. Seal proof action is `seal` and phase is
`frozen`. Activation proof action is `activate`, phase is `activating`, and it
also contains the exact `activationId` already durably written by the portal.
Seal body is `{portalProof}`; activation body is `{portalProof, activationId}`.
These proofs contain no runtime capabilities and are not persisted in receipts.

Prepare also requires a proof: action `prepare`, phase `frozen` (or `imported`
for an unchanged retry), the same source/operation/epoch/snapshot/export binding,
without `stageId` before reservation. The manifest's portal origin must equal the
configured signing issuer. This proof authorizes the exact immutable export,
including explicit inactive historical-identity creation, never active login
provisioning. The operator driver implements the same canonical HMAC format.

Readback returns `receiptId`, all matching binding fields, `hostState`, `stage`,
`verification`, `receivedChunks`, and active-only `activationId`. Abort returns
`hostState:'inactive', activationForbidden:true`. The trusted portal readback
adapter adds `verified:true` only after authenticating and checking this response.

SQLite rows, pointer and FIFO audit outbox are durable and projected before the
D1 seal. Activation atomically commits its D1 receipt, current grants and source
readiness; it also checks current principal/organization status in that D1 CAS.
There is no cross-D1/SQLite transaction. An unknown response is recovered by
readback/retry with the saved IDs. The portal must never thaw after its activation
intent, even when the response is lost. Before intent it can thaw only after
authenticated terminal-abort readback.

Validation so far is syntax/typecheck/build and manual SQL review, with no new
tests or test runs as requested. Live import, abort/recovery, ownership transfer,
and post-cutover publication remain required acceptance work.
