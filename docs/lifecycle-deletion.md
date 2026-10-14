# Source deletion

Source deletion uses a reviewed, durable cleanup operation. Local checks do not
establish deployed lifecycle acceptance; verify the complete protocol only on an
explicitly authorized disposable source, as described in
[verification](verification.md).

Deletion permanently retires the source UUID and public serving authority. It
removes mutable session forks, the exact source repository, its owned Preview
Worker/Builds connection, live runtimes, fork event subscriptions, source grants
and exactly scoped media originals. It **retains** immutable RELEASES bytes,
source/build snapshots, publication receipts and audit history; bucket locks are
never disabled. Some historical versions refer directly to snapshots, so those
objects remain retained and inaccessible through the deleted source. Shared
dependency caches, Artifacts namespaces and operator credentials remain in
place. Existing copies already downloaded or cached by clients cannot be
recalled. This is not a promise of physical erasure.

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

Ready native sources require the completed coordinator provision receipt and
its exact provider repository ID. If D1 committed completion before the local
checkpoint, deletion independently verifies the exact completion authority
receipt, including source, original actor, repository, manifest and commit.
Another current administrator can then delete the source even if the original
creator is inactive; review does not rewrite the provisioning operation.
A partially provisioned native source can
also be deleted when its coordinator checkpoint preserves the exact repository
creation receipt. Deletion uses that receipt even if provisioning did not yet
write the repository ID to D1, and permits independently verified repository
absence. A source with no creation receipt cannot adopt an existing repository
by name and requires operator recovery. Confirmation fences any further
provisioning checkpoints and completion as well as ordinary authoring.

New session forks keep an immutable SQLite
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
freshness before each capability revocation, repository removal, media removal,
and each Preview connection, Builds configuration or Worker removal. If stale,
it pauses as `awaiting_consumer_proof` until explicit resume.
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

Live runtimes stop before media cleanup begins. Bounded uploads that are still
draining leave the operation `queued` in the `remove_media` phase with a durable
retry deadline; an alarm resumes automatically. Draining does not require a new
review or confirmation for native sources. Imported sources still need a fresh
portal proof before the eventual destructive steps. Canceled objects are checked
for absence before their purge receipt commits. Once deletion is fenced, media
cleanup runs only through this lifecycle operation, including after a restart.
Unprocessed upload batches retry promptly rather than waiting for their ordinary
upload expiry; transfers already canceling keep their bounded drain deadline.

Live credentials, delayed repository operations, publication and Request work,
and delayed Preview receipts are rejected after the fence. Final verification
requires all planned repositories absent, the owned Preview absent and all
source grants revoked. A D1 `deleted` authority receipt precedes the completed
SQLite tombstone and audit event. The catalogue identity remains reserved, and
admin source views retain minimal name/ID/lifecycle metadata while ordinary
authoring and anonymous public roots are unavailable.
