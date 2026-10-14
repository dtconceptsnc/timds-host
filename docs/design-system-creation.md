# Creating Design Systems

An active host administrator can create a native standalone Design System from
Studio's **Create Design System** action. Choose an active organization, a deployed
Artifacts namespace, a display name and an immutable system ID. An installation
with no organization can create its first one in the dialog. Namespace bindings
remain an operator configuration task; creation never inventories or adopts
other repositories in the account.

## API

All calls use API v1 and existing OAuth authorization. Mutations require both
`timds:read` and `timds:write`; current D1 administrator authority is checked
independently of scopes.

| Method and path | Behavior |
| --- | --- |
| `GET /api/timds/admin/organizations` | Active organization IDs and names, at most 200 per page. |
| `POST /api/timds/admin/organizations` | Reserve `{id,name}`; retrying the UUID returns the existing organization. |
| `GET /api/timds/admin/systems` | Minimal system metadata across lifecycle states and the configured creation namespaces. |
| `POST /api/timds/admin/systems/create` | Initialize the built-in starter and grant its creator read/write/publish. |
| `POST /api/timds/admin/systems` | Existing advanced provisioning with an exact caller-supplied file tree. |
| `GET /api/timds/admin/systems/{sourceId}/provision/{operationId}` | Initiating administrator's independently checked provisioning receipt. |

List responses contain `nextOrganizationCursor` or `nextSystemCursor`; supply
that UUID as `?after=` until it is null. The administrative system list includes
`provisionOperationId`, `deletionOperationId` and, for a built-in starter created
by the current administrator, `creationInput`. This input contains the original
form fields and starter version, never source files or credentials. It allows
the same administrator to resume on another device. Ordinary discovery still
lists only ready, unarchived systems.

`creationPending` also covers a ready starter whose final creator grant has not
committed. Studio offers **Finish setup** for that gap; retrying reuses the same
grant operation and does not restore access intentionally revoked afterward.

The creation body is:

```json
{
  "apiVersion": 1,
  "operationId": "<stable-provisioning-uuid>",
  "sourceId": "<fresh-source-uuid>",
  "organizationId": "<organization-uuid>",
  "systemId": "example/core",
  "name": "Example core",
  "namespace": "example-org",
  "starterVersion": 1
}
```

`starterVersion` defaults to 1. System IDs are lowercase, slash-separated
segments using letters, digits, dots, underscores and hyphens, beginning with
a letter or digit. The source UUID determines the repository and Preview Worker
name: `timds-` followed by that UUID without hyphens. A successful response has
`source.lifecycle_status: "ready"`. Creation does not publish a public release.

The starter is a deterministic standalone hosted toolkit scaffold pinned to
`@dtconcepts/timds@0.1.464`, with an npm lockfile and the host's supported `cf`
Preview configuration. It supplies guidance, contracts, build scripts and agent
instructions so the first working session can build and submit normally. Its
seed version is a fixed baseline; publication assigns the actual release.
The host fills only source identity, name, hosted origin and Preview identity.
Existing sources and imported systems are never rewritten.

`node scripts/generate-design-system-starter.mjs` regenerates the synthetic seed
in a temporary directory, checks every source byte against the frozen starter,
installs its lockfile, runs the toolkit checks/build and verifies that local
`cf build` packages the same assets. It makes no cloud deployment. Changing a
starter's dependency pins requires a new revision; preserve old revision bytes
for interrupted creation retries.

## Recovery and teardown

Save the exact body and both UUIDs before sending it. D1 reserves the immutable
input digest before any repository side effect. Repeating the body resumes the
same operation, including a separately durable publisher grant. A different
body or reuse of an existing system/source identity fails closed. Studio keeps
an interrupted form in principal-scoped tab storage and also reads the saved
server input from the administrator catalog.

Repository creation and its exact provider receipt execute under the same
coordinator queue as deletion review. File initialization runs outside that
queue so native callbacks can proceed, but its credentials and completion
recheck the lifecycle lease, current administrator and deletion fence. A source
cannot return to ready after confirmed deletion.

Deletion uses the [reviewed deletion protocol](lifecycle-deletion.md), including
partial provisioning when an exact repository creation receipt exists. A lost
provider creation response cannot be repaired by adopting a repository name;
an operator must resolve that unknown ownership before cleanup. Namespaces and
shared installation resources remain in place. Source UUIDs and system IDs
remain reserved after deletion.

## Validation

Run the root typecheck, build, smoke suite, documentation and boundary checks.
Run the conformance package's local tests for contract validation. These local
checks do not establish deployed acceptance. Its separately guarded
`npm run test:lifecycle` covers fresh creation, exact retries, live sessions,
frozen Preview and reviewed teardown; see the
[fixture requirements](../conformance/README.md#native-creation-and-teardown-acceptance).
On an explicitly authorized
disposable fixture, verify creation retry, session startup, Preview/publication,
reviewed deletion during live work, interrupted cleanup recovery, removed public
access, retained audit and rejected identity reuse. Never run this against a
production source or record installation receipts in this repository.
