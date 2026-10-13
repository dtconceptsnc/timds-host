# Coordinator and store port review

Read-only Phase 2 preparation for #69. Domain implementation is still blocked
on production-portal conformance. This document specifies proposed code and
records inspected behavior; none of the adapters below is implemented yet.

## Provenance and minimal reuse

Reviewed portal master `2b0148c70b363967ad0ea2eda092f7d0b442b93b`, available in
the extraction worktree at `46424ca933425fed2a0c1754b71c332f865bda7f`. The latter
adds only the callback-origin/runbook work from portal PR #78. Relevant sources:

- `server/design-system-sessions.mjs`: domain operations, validation, views and
  public token CSS. Keep the v1 wire shapes and latest `no-store` preview header.
- `server/design-system-collaboration-store.mjs`: exactly 50 adapter methods,
  listed below. Its Supabase implementation is a reference, not portable code.
- `server/design-system-session-repository.mjs`: two pure path/resolution
  validators plus an RPC re-export. Extract the validators into a small domain
  module so importing sessions does not pull in the repository transport.
- Migrations `20261012210000_design_system_hosted_sessions.sql`,
  `20261012225000_design_system_principals.sql`,
  `20261012230000_submission_publication.sql`,
  `20261013000000_timds_multiplayer.sql`, and
  `20261013001000_design_system_publisher_rollback.sql`: transaction semantics,
  constraints and authorization, not just table definitions.

Vendor the session domain with a required injected store; remove its default
Supabase factory import. Replace `requireTimdsSessionActor` and the Node
request/response router with the root Worker's verified actor and Fetch router.
`node:crypto`, `node:path` and `Buffer` are the remaining runtime dependencies;
the host already enables `nodejs_compat`. Preserve SHA-256 canonical request
hashing, base64 checks, symlink/path validation and locale-sorted change sets.
No npm runtime dependency is needed for the SQLite store. Typed declarations
or deliberate `allowJs` configuration will be needed for vendored `.mjs` under
the host's strict TypeScript setup.

Omit optional `store.heartbeat`, avoiding the legacy timer. Keep bounded leases,
fenced progress checkpoints and durable alarm recovery. Repository and live
adapters remain injected. Phase 2's real start/pull/draft/history/preview checks
already need repository RPC; a fake repository cannot establish conformance
while the native repository port is deferred to Phase 3.

## Exact store surface

All results are plain JSON rows/scalars, promises allowed. Missing singleton
rows return null; lists return arrays. Preserve these distinctions rather than
leaking SQL cursors. Source-scoped methods always validate coordinator identity.

| Methods | Required behavior / result |
| --- | --- |
| `source(systemId)`, `getSource(id)`, `eligible(source)` | Active unique system lookup (404/409), arbitrary source lookup for cleanup/history, boolean eligibility. |
| `version(sourceId,label)`, `publishedRelease(source,label?)`, `resolveRollbackVersion(sourceId,value,byId=false)` | Respect first publication of a label; return `{source_commit}`, `{contentDigest,version,sourceCommit}`, or version UUID/null respectively. Current release reads canonical pointer. |
| `publicationEventsForSources(ids)` | Cross-system audit read through catalog projection, ordered newest first; not a writable pointer. |
| `get(id)`, `byKey(principalId,key)`, `insert(row)`, `sessions(sourceId)`, `draft(sourceId,name)` | Session rows. `sessions` selects starting/open/closing oldest first; `draft` returns starting/open only. `byKey` is globally principal-scoped. |
| `updateSession(id,patch)`, `findFork(name)`, `sessionForRequest(sourceId,requestId)`, `expired(isoNow)` | Trusted live/lifecycle updates, fork and Request lookup; expiry selects starting/open/closing with non-null due expiry, max 100. |
| `members(id)`, `member(id,principalId)`, `addMember(row)` | Member rows; lists include `principal:{id,name,type}`. Insert-ignore preserves an existing role; duplicate `addMember` may return null. |
| `claims(id)`, `putClaim(row)`, `removeChangeClaim(id,principalId)` | Only unexpired claims returned, with principal display embedding. Upsert unique session/principal/kind; removal affects changes claims only. |
| `hasSessionAccess(principalId,sourceId)` | True for membership in an open, unexpired session/draft; this never confers publication rights. |
| `claim(id,lease,publicationId=null)`, `release(id,lease)`, `checkpoint(id,lease,patch,submission=null,event=null)`, optional `heartbeat(id,lease)` | Lease-fenced session transactions. Claim returns row; checkpoint returns updated row. Release is conditional on matching lease. Host omits heartbeat. |
| `getSubmission(id)`, `submissions(sessionId)`, `submissionsForSource(sourceId)`, `submissionByHash(sessionId,hash)` | Submission rows; lists newest first, source list max 50. |
| `reserveSubmission(row)`, `markIntegrated(id,revision)`, `closeSubmissions(sessionId)` | Reserve preparing row; integration marks closed (legacy revision argument is unused); close changes only preparing/submitted. |
| `appendEvent(event)`, `events(sourceId)`, `publications(sourceId)` | Append-only audit; last 100 rows newest first. Read views add `principal_name` and `actor_name`. |
| `eventForHead(sessionId,revision)`, `requestReceipt(sessionId,requestId)` | First returns array `[{id}]` or `[]`; second returns latest submitted `{submission_id}` or null. Do not change array to boolean. |
| `publication(id)`, `publicationBySubmission(id)`, `publicationsForSource(sourceId)` | Publication rows; source list max 50 newest first. |
| `reservePublication(sourceId,submissionId,actor)`, `attachPublicationJob(id,jobId)` | Idempotent publication reservation/FIFO sequence; logical execution association returns publication row. |
| `claimPublicationJob({jobId,leaseToken,leaseOwner,leaseSeconds})` | Current execution-job lease receipt/null; replace backend with Workflow attempt fencing when ported, not a generic portal job runner. |
| `checkpointPublication(id,lease,patch)`, `releasePublicationVersion({publicationId,versionId,jobId,leaseToken})` | Publication checkpoint and authorized pointer commit. Follow the D1/DO protocol in architecture.md; no distributed transaction claim. |
| `deletionInventory(sourceId)`, `getLifecycleOperation(id)`, `getExecutionJob(id)` | Inventory `{sessions,submissions}`; two legacy repository-control lifecycle receipt readers. Adapt narrowly to host provisioning/deletion operations. |

## Stored rows and constraints

Keep snake_case rows and existing empty-string/null defaults so vendored domain
views need minimal changes. JSON arrays/objects decode before returning. Use
normalized key/status/deadline columns plus JSON for flexible payloads, updated
together in SQLite transactions; do not let a JSON patch override identity.

| Row | Fields required by current domain |
| --- | --- |
| Source | `id, system_id, organization_id, lifecycle_status, archived_at, artifacts_namespace, artifacts_repository, artifacts_repository_id, manifest_json, published_version, source_commit, content_digest`; optional imported catalog/provenance fields remain metadata. |
| Session | `id, source_id, owner_principal_id, owner_user_id, owner_token_id, originating_request_id, idempotency_key, kind, name, draft_session_id, origin_revision, fork_repository, token_id, base_revision, last_update_hash, status, expires_at, lease_token, lease_expires_at, live_url, sandbox_id, live_state, created_at, updated_at`. |
| Member | `session_id, principal_id, role, invited_by, created_at`; read embedding `principal:{id,name,type}`. |
| Claim | `id, session_id, principal_id, patterns, note, kind, expires_at, created_at`; same principal embedding. |
| Submission | `id, source_id, session_id, request_hash, base_revision, head_commit, review_branch, preview_url, diff_json, note, status, target_draft_session_id, published_by, published_at, created_at, updated_at`. |
| Submission event | `id, source_id, session_id, submission_id, event_type, actor_user_id, actor_token_id, actor_principal_id, originating_request_id, details_json, note, merged_keys, conflicted_keys, created_at`. |
| Publication | `id, source_id, submission_id, execution_job_id, actor_user_id, actor_principal_id, originating_request_id, actor_email, status, stage, checkpoints_json, result_json, error_message, queue_position, conflict_rate, auto_rebase_success, submit_to_publish_ms, created_at, updated_at, completed_at`. |
| Publication event | Preserve legacy read fields `id, design_system_source_id, design_system_version_id, action, actor_user_id, actor_principal_id, originating_request_id, version_label, content_digest, created_at`; add internal sequence/outbox receipt without altering existing views. |

Required invariants:

- Session statuses: starting/open/closing/closed/expired. Drafts have a name and
  null expiry; ordinary sessions have an expiry. A live draft name is unique
  across **starting/open/closing**, even though lookup excludes closing.
- Session start key is unique **globally** on `(principal,key)`. Reserve in D1
  before local insert with `{source_id,session_id,origin_fingerprint}` and a
  durable receipt; recover partial failure idempotently. Another source/origin
  using the same key gets 409. Retain reservation/tombstone across cleanup.
- Submissions are unique on `(session_id,request_hash)` and
  `(source_id,review_branch)`; publication is unique per submission and queue
  position per source. Member and claim composite keys match the table above.
- Claim expiry never blocks editing. Explicit advisory claims accept 1–100
  patterns; generated changes claims can hold up to 4,000 paths. Notes max 2,000.
- Session claim rejects an existing unexpired lease with the exact busy error
  used by Request retry. The current lease lasts 15 minutes. It also rejects a
  pending/staged publication, except its own matching closing cleanup receipt.
- Checkpoint requires matching unexpired lease, permits only the current patch
  fields, and atomically updates session, optional preparing submission, audit
  and outbox. A changed submission rolls back the whole checkpoint. Preserve
  explicit `expires_at:null` separately from an omitted field.
- Publication queue blocks on earlier queued/running/closing work and failed
  work with `sourceCommit` or `staged`. Failed unstaged work may be superseded.
  Checkpoint preserves committed pointer receipt fields; cleanup of a committed
  publication does not republish after grant loss.
- Audit survives system removal. Retain local canonical history plus idempotent
  D1 projection; `deleteAll()` is not a system-removal implementation.

## Agreed root authorization seam

The coordinator/store owner supplies Catalog/schema. Root supplies verified
OAuth/Access identity, the authorization factory and HTTP routes. Agreed names:

```ts
type PrincipalRow = {
  id: string;
  type: 'user' | 'agent';
  name: string;
  issuer: string;
  subject: string;
  status: 'active' | 'deactivating' | 'inactive';
  admin: boolean;
  version: number;
};

Catalog.resolveIdentity({ issuer, subject, type, name }): Promise<PrincipalRow>;
Catalog.principal(id): Promise<PrincipalRow | null>;
Catalog.bootstrapAdmin(actor, operationId): Promise<PrincipalRow>;
Catalog.source(reference): Promise<SourceRow | null>;
Catalog.resource(kind, id): Promise<{ source_id: string; tombstone: boolean } | null>;
Catalog.sourcesForPrincipal(principalId): Promise<SourceRow[]>;
Catalog.readAuthority(sourceId, principalId): Promise<{
  principal: PrincipalRow | null;
  source: SourceRow | null;
  organizationStatus: string | null;
  access: { read: boolean; write: boolean };
  publisher: boolean;
  authorityVersion: number;
  principalVersion: number;
}>;
```

`resolveIdentity` uniquely maps verified issuer/subject and may create an active
non-admin; it never resurrects an inactive principal or derives admin from
email/token claims. `readAuthority` uses a fresh D1 primary read; it must not
reuse an old read-replica session. Fields are permission facts, not a decision
that bypasses OAuth scope enforcement.

`principal(id)` also reads current status; root authenticates each protected
call. `source(reference)` resolves UUID or immutable system ID and may return
archived metadata for authorized cleanup/history; the session adapter applies
its active-only lookup rule. Catalog source rows are metadata/locators: the
coordinator overlays the canonical current pointer before public/domain use.
`resource` returns a locator only. `sourcesForPrincipal` includes admin,
system-access, publisher and active-session invitation visibility through a
D1 index; the result is not permission to mutate. Recheck authority in the
coordinator. Reconcile invitation visibility before acknowledging a new member,
and deny stale listed entries when current session access has expired.

`bootstrapAdmin` is a one-time installation CAS, not an ordinary role setter.
Root first validates an Access identity and `TIMDS_BOOTSTRAP_SECRET`; it passes
only the verified principal actor and operation UUID, never the secret. One D1
transaction binds the installation bootstrap receipt to that active principal
and sets admin. Exact actor/operation replay returns the same receipt/result;
other callers cannot consume/reset it or bootstrap a second administrator.
Principal deactivation does not clear the bootstrap receipt. Root's proposed
Access adapter verifies RS256, configured audience and fixed team-domain certs;
verified issuer/stable subject is identity, never raw headers or email.

Root's factory wraps Catalog and injected coordinator `hasSessionAccess` and
`requestBinding` readers, exposing existing domain signatures:
`authenticatePrincipal(id)`, `authorizeSource(source,actor,{starting=false}={})`,
`authorizePublish(source,actor)`. The domain actor remains
`{principalId,type,userId:null,tokenId:null,email?,operator}`; operator derives
only from D1 admin. Retain imported UUID audit references when applicable, but
do not put OAuth token strings or arbitrary credential identifiers in those
fields. Scope checks remain separate from D1 grants.

Replace the portal's client/project/repo eligibility joins with active host
organization + source lifecycle + verified repository identity. `ready` and
`deleting` are existing source lifecycle values; new provisioning states are
internal and never eligible. Do not fabricate portal client/project rows.
Admin/source access/invitation can allow authoring, but publishing always
requires its separate grant. Existing session ownership/membership is a
trusted domain fact after row lookup, not a caller-supplied actor flag.

Runner-only `sourceId/requestId` authority comes from a persisted Request bound
to the same source/requester/session. No incoming JSON can mint it. Closed
session history retains the original membership/owner read behavior while
`hasSessionAccess` grants source-wide access only through open sessions.

## Proposed provisioning and coordinator seam

These names are proposals for root integration, separate from the agreed auth
methods above:

```ts
Catalog.reserveSystem({ operationId, actor, source }): Promise<ProvisionReceipt>;
Coordinator.initializeSource({ operationId, source, reservation }): Promise<ProvisionReceipt>;
Coordinator.checkpointProvision({ operationId, lease, patch }): Promise<ProvisionReceipt>;
Coordinator.completeProvision({ operationId, lease, repositoryReceipt, sourceCommit, manifest }): Promise<SourceRow>;
```

D1 `systems` columns: UUID `id`, unique `system_id`, `organization_id`, lifecycle,
archive state, immutable Artifacts identity, authority version and `source_json`.
`source_json` is metadata; materialization overwrites protected ID/lifecycle
fields from canonical columns. Initial reservation atomically binds operation,
creator, system ID and organization/repository. Only its owning coordinator may
advance lifecycle afterward. No portal route gets a direct D1 mutation helper.

Root's provisioning orchestrator validates namespace policy, obtains the remote
repository/scaffold receipt and calls those coordinator methods. Completion
checks the immutable repository ID, source commit and manifest system ID before
making the source ready. Bootstrap publisher grant, if requested by this
provisioning policy, uses the same coordinator/D1 authority protocol as every
later grant. Failures leave a recoverable non-ready reservation; never expose
a half-provisioned source or invent a portal execution job.

Minimal additional D1 tables: organizations, principals, system_access,
publishers, authority-operation receipts, start-key reservations,
resource_index and append-only audit/publication projections. Scope uniqueness
to organization/repository and verified identity; preserve source UUIDs during
import. Global principal deactivation and all grant mutations follow the
serialized protocol in [architecture.md](../architecture.md).

Store construction remains
`createSqliteCollaborationStore({sourceId,storage,catalog,authority,clock,ids})`.
Coordinator operation dispatch, repository control, publication steps, callbacks,
migration and alarms are binding-only, with an exhaustive allowlist. Root HTTP
routes call them with a verified actor; they do not call SQL adapters directly.

## Verification to implement after the gate

Reuse portable session-domain cases from `design-system-sessions.test.mjs` and
the newer multiplayer/live tests. Existing PGlite transaction tests establish
behavior but do not test SQLite: exercise actual DO SQLite constraints and
restart recovery, not a Map adapter. Add global-key cross-source races, closing
draft-name contention, membership principal display, null-expiry patching,
checkpoint rollback, stale leases, FIFO/revocation and outbox crash points.
Then run the unchanged black-box suite through the toolkit against real backing
services. The single existing collaboration-store test only checks Supabase's
ambiguous member relation selection; passing it is not store conformance.
