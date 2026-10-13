# Source deletion

Implementation is prepared for #69. It has passed JavaScript syntax, typecheck
and a real `cf build`. No deletion has been exercised against the acceptance
fixture or production sources. No new tests were added or run, as requested.

Deletion permanently retires the source UUID and public serving authority. It
removes mutable session forks, the exact source repository, its owned Preview
Worker/Builds connection, live runtimes and source grants. It **retains** immutable
RELEASES/media bytes and audit history; bucket locks are never disabled. Existing
copies already downloaded or cached by clients cannot be recalled. This is not
a promise of physical erasure.

## Administrator protocol

All routes require an active host administrator and use the source coordinator:

| Method and path | Behavior |
| --- | --- |
| `POST /api/timds/admin/systems/:sourceId/deletion` | `{operationId}` prepares a provider-read-only inventory and durable review receipt. |
| `GET /api/timds/admin/systems/:sourceId/deletion/:operationId` | Returns bounded progress; never provider tokens or portal proofs. |
| `POST /api/timds/admin/systems/:sourceId/deletion/:operationId/confirm` | `{impactHash,typedRepository}` confirms the exact repository name and current impact. Imported sources also require server-supplied `portalConsumerProof`. Returns the durable queued receipt, not completion. |
| `GET /api/timds/admin/systems/:sourceId/deletion/:operationId/history` | Retained bounded session/audit descriptors for an active administrator. |

The direct response contains `operationId`, `sourceId`, `status`, `phase`,
`repository:{id,namespace,name}`, `impactHash`, counts for sessions/forks/publishers/
Requests, retention policy, `requiresConsumerProof`, `awaitingConsumerProof`, a
fixed safe error, and timestamps. It does not expose the private cleanup plan.
Statuses are `awaiting_confirmation`, `queued`, `running`,
`awaiting_consumer_proof`, `failed`, and `completed`.

Preparing is read-only against providers. Confirmation rereads the actual
repository and all owned forks, Preview identity, grants and local work. Any
impact change requires a fresh operation UUID and another review. Unconfirmed
plans remain inert audit. After confirmation, only the fenced operation can
continue; the source cannot be restored or reprovisioned under the same UUID.
The current admin can confirm the same hash/name again to resume a failed step
or refresh an expired portal proof. Completed confirmations return the receipt.

Sources need an actual native provisioning reservation, or an active import
reservation that proves the original dedicated standalone repository. Unknown
provenance, shared/embedded repositories, changed opaque provider IDs and pending
publications fail closed. Native provisioning records represent sources without
portal consumer relationships; they do not fabricate a portal consumer check.

Native provenance also requires the completed coordinator provision receipt and
its exact provider repository ID. New session forks keep an immutable SQLite
creation receipt from the provider's creation response; an existing fork is never
adopted by name after a lost response. Deletion refuses every still-existing fork
without that receipt, including historical sessions. Independent absence is safe.
For pre-receipt native sessions only, ordinary close retains its existing behavior
so already accepted work can finish. Receipted sessions verify exact fork IDs on
start, capability minting and close. This transitional compatibility does not
weaken source deletion. Preview cleanup likewise requires the reviewed Worker
tag, then checks it again before removing the script by name.

## Imported consumer authority

Portal consumer relationships remain canonical for imported systems. The portal
backend must reserve and reread a durable source attachment fence under the same
source lock used by consumer/site-provision/reactivation writes. It refuses
active or unresolved consumers and confirmed pending site provisioning. This
barrier stays closed through cleanup failures and retries; it is never thawed by
a timeout. A fresh plan can use another operation UUID while the source barrier
remains closed. This prevents attachment after a zero-consumer read.

Only that backend signs `action:'delete-consumers'` using the deployment-only
transfer HMAC. Its receipt binds `sourceId`, `operationId`, `impactHash`,
`consumerFenceId` (the operation UUID), `consumerFenceEpoch` (the imported
ownership epoch), `activeConsumers:0`, and the actual canonical consumer digest.
Issuer and audience must match the imported portal and this host. Expiry is at
most 120 seconds. Browser flags, counts and unsigned evidence cannot substitute.
The host stores verified facts and expiry, never the proof itself, and checks
freshness before each capability revocation/repository removal and Preview
removal. If stale, it pauses as `awaiting_consumer_proof` until explicit resume.
The additive portal barrier migration is a required deployment prerequisite;
without it, imported deletion remains unavailable.

## Persistence and recovery

One SQLite transaction saves the confirmed intent, local deletion fence,
session-closing state, canceled Request job leases and audit outbox. Source reads
immediately overlay that fence, including anonymous public reads. The existing
serialized authority protocol then commits a D1 `deleting` receipt. There is no
cross-database transaction: partial outcomes remain closed and alarms retry the
same durable intent. Public grant mutation and archive/restore cannot clear it.

Cleanup runs outside the coordinator mutation queue so native live callbacks do
not deadlock it. Each external step uses a persisted expiring lease and commits
its checkpoint through the queue. Every provider deletion rereads the exact
opaque identity; an unexpected replacement stops cleanup. A lost response is
recovered by independent absence reads. A process eviction expires its lease and
the next alarm resumes; an explicit provider failure pauses for administrator
review instead of repeatedly deleting resources without feedback.

Live credentials, delayed repository operations, publication and Request work,
and delayed Preview receipts are rejected after the fence. Final verification
requires all planned repositories absent, the owned Preview absent and all
source grants revoked. A D1 `deleted` authority receipt precedes the completed
SQLite tombstone and audit event. The catalogue identity remains reserved, and
admin source views retain minimal name/ID/lifecycle metadata while ordinary
authoring and anonymous public roots are unavailable.
