# Explicit source access invitations

The acceptance host deployment `f655a24` includes this implementation, and
migration `0004_access_invitations.sql` was applied on 2026-10-13.
`TIMDS_ACCESS_INVITATIONS_ENABLED` remains false; no invitation has been reserved
or claimed and no invitation grants have been applied. Enable it only at the
reviewed source-access boundary after checking the deployed schema and policy.
The default is false: ordinary OAuth keeps working without querying invitation
tables. The Access application must independently permit the invited person's
own authentication; creating an invitation does not edit an Access policy.

An active host administrator can reserve explicit source permissions for a
specific verified Access email and issuer. The invited person signs in as
themselves through Access, then authorizes their own OAuth client. The host binds
the invitation once to that assertion's actual stable subject/principal. It does
not log into another person's account, send email, confer administration, infer
identity from a portal profile, or merge an imported historical identity. A
historical person's archive identity stays inactive and distinct even if its
display name resembles the invited address.

## Administrator API

All routes require current host administrator OAuth and enter the source's
normal serialized mutation queue.

| Route | Action |
| --- | --- |
| `POST /api/timds/admin/systems/:sourceId/invitations` | Reserve immutable reviewed email/issuer/permissions under an invitation UUID |
| `GET /api/timds/admin/systems/:sourceId/invitations` | List up to 100 source invitations |
| `GET /api/timds/admin/systems/:sourceId/invitations/:cursor` | Continue after `nextCursor` |
| `POST /api/timds/admin/systems/:sourceId/invitations/:invitationId/revoke` | Revoke an unclaimed invitation; body `{}` |

Reservation body:

```json
{
  "invitationId": "a privately generated stable UUID",
  "email": "collaborator@example.com",
  "issuer": "https://example.cloudflareaccess.com",
  "read": true,
  "write": true,
  "publish": true
}
```

The issuer must equal this host's configured Access issuer. Email matching uses
the lowercased signed Access email, never a browser field or HTTP email header.
At least one permission is required; write also requires read. Retry with the
same UUID, administrator and immutable fields after a lost response. A second
pending invitation for the same source/issuer/email conflicts; revoke the old
pending invitation before creating a different reviewed one. Concrete addresses,
UUID mappings and operator payloads belong in private mode-0600 files, never in
public repository examples or fixtures.

The response includes `id,sourceId,issuer,email,permissions,status,requestedBy,
createdAt,claimedPrincipalId,claimedAt,revokedAt`. Status is `pending`, `claimed`
or `revoked`. List replies add `apiVersion:1,sourceId,invitations,nextCursor`.
These administrator views contain identity data and use the API's no-store
headers. A revoked invitation never becomes pending again. Once claimed, change
the person's source permissions through the ordinary grant API; revoking an
invitation does not undo already-granted permissions.

## Readiness and recovery

A reservation may be made for an inactive `importing` source, or a ready source,
with an active organization and no archive/deletion fence. It grants no access
at reservation time. Claim requires a ready, unarchived source, active
organization, active verified human principal, and an authorizing administrator
who is still active. Importing/deleted/deleting/archived sources never claim.
An unclaimed reservation has no automatic expiration; it stays pending until an
administrator revokes it or an eligible verified sign-in claims it. If readiness
changes after an earlier login, reconnect through a fresh Access/OAuth
authorization after the source activates. Existing OAuth tokens are not treated
as proof of the current email's control.

The normal OAuth authorization flow performs a bounded pending-invitation
lookup for the signed issuer/email and calls each owning coordinator. The
coordinator verifies the RS256 Access assertion again against configured
issuer/audience/JWKS. Assertions and login credentials remain transient and are
never stored in the invitation, authority journal, audit or logs.

The coordinator writes an `authority_pending` intent containing only verified
identity facts and reviewed grants. One D1 transaction CAS-claims the invitation,
checks source/organization/principal/authorizing-admin readiness, inserts the
authority receipt, adds permissions and advances the source authority version.
Existing stronger permissions remain intact. The regular DO authority outbox
records the grant audit. There is no cross-D1/SQLite transaction; the pending
intent and immutable D1 receipt allow alarm/request recovery after a lost
response. An uncertain outcome keeps the source authority barrier until receipt
reconciliation. Claimed reservations never grant again on later logins, so an
ordinary subsequent permission revocation is preserved.

SQL guards retain invitation receipts and prohibit changing their identity or
permission binding. Explicit pending-to-revoked or pending-to-claimed are the
only transitions. Global principal deactivation, source archive/deletion and
publisher permission checks continue to use the current D1 authority.

Validation is syntax/typecheck/build and manual SQL review only. No tests were
added/run and no other person's sign-in was attempted. The schema application
above does not prove an invited-user claim; that requires the person to
authenticate themselves.
