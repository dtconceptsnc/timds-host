# Native provisioning receipts

The retained portal catalogue can register a newly created host source after
independently reading its native provisioning receipt. This is separate from
legacy source import and does not create a transfer operation.

`GET /api/timds/admin/systems/{sourceId}/provision/{operationId}` requires the
active host administrator who initiated that exact operation. The host reads
the D1 reservation and coordinator lifecycle, checks their source, actor and
file-tree digest, and verifies the completed repository receipt against the
current source. It exposes no credential, lease or source file body.

The response contains `provision` with operation/source/actor identifiers,
status, exact `fileTreeDigest` and requested `grantPublisher`; `source` contains
the current system/organization identifiers, name, namespace, repository name
and immutable repository ID, lifecycle, archive timestamp, source commit and
manifest. A pending lifecycle remains pending. Missing or mismatched receipts
fail closed; the endpoint never repairs or adopts them.

The portal must compare the response with its reserved creation operation,
require completed provisioning and a ready unarchived source, and register
Client/Project/catalogue ownership transactionally. Reading a receipt alone
does not grant source access, establish portal ownership or authorize a new
creation. A different administrator cannot claim another human's operation.
