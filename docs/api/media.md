# Source media

Native media belongs to the source coordinator. Its SQLite rows record upload,
part, capability and asset state; bytes live in the native `MEDIA` R2 binding.
Every control operation and transfer capability rechecks current D1 principal,
source and organization authority. Archived/deleting sources and inactive
principals cannot upload, complete or obtain private downloads. Public delivery
uses the separate public Worker origin.

## API

All control routes use ordinary host OAuth and API version 1. Replace `{source}`
with the source UUID. UUIDs in child routes are resolved within that source.

| Method | Path under `/api/timds/design-systems/{source}/media` | Result |
| --- | --- | --- |
| GET | empty | Bounded asset list and explicit truncation |
| POST | `/uploads` | Asset plus single/multipart transfer plan |
| POST | `/uploads/{upload}/parts` | One part capability; body `{partNumber}` |
| POST | `/uploads/{upload}/complete` | Verified ready asset; multipart body `{parts:[{partNumber,etag}]}` |
| DELETE | `/uploads/{upload}` | Durable cancellation; `pending:true` while a bounded transfer drains |
| GET | `/{asset}/download` | Existing public URL or a five-minute private download capability |
| POST | `/{asset}/archive` | Remove exactly owned media bytes and retain an archived audit row |

Create accepts `filename`, MIME `contentType`, integer `bytes`, lowercase SHA256,
optional `key`, `kind`, `title`, `tags`, and public visibility. Responses preserve
the toolkit media shape (`asset`, `reused`, `upload`, child URLs and headers).
Ready digest reuse changes metadata only. Uploads use a new object key and asset
UUID, so archived URLs are never rebound to different content.

Released TimDS 0.1.472 uses `/api/operator/design-system-assets/uploads` for the
initial request. The host rewrites only that exact POST into its authenticated
`/api/timds/media/uploads` route, resolving `sourceId` or `systemId`. The returned
control URLs are canonical source-bound paths. Use the host's own OAuth login;
legacy portal tokens are not host credentials.

## Transfers and verification

Plans expire after one hour. Single transfers are at most 32 MiB; larger files
use 16 MiB multipart parts and at most 10,000 parts (167,772,160,000 bytes total).
This native limit is deliberately below the old S3 client's nominal 5 TiB bound
so each transfer fits Workers request limits. Part capabilities expire within
15 minutes and are bound to source, principal, upload and part; only their
SHA256 hashes persist. No R2 signing credential reaches the browser or CLI.

The client PUTs bytes to the supplied public-origin URL with its supplied
Authorization header and exact content length. Each part can start once.
Completion requires every recorded part receipt and no unfinished transfer.
Retry completion after an unknown response; cancel and create a new upload if a
part failed or its worker disappeared. A failed part is never taken over with
another writer using the same R2 part. Transfers and full-object hashing have a
10-minute bound. R2 validates the supplied SHA256 on single PUT; completion
streams the full stored object through `crypto.DigestStream` and checks both
length and SHA256 before marking it ready.

The source alarm retries cancellation and archive cleanup. Cancellation waits
for bounded in-flight transfers before deleting the owned key and verifies its
absence before saving the purge receipt. Source deletion stops live work first,
then automatically resumes media cleanup after bounded transfers drain; it stays
queued in `remove_media` while waiting. Once fenced, only the deletion operation
runs media cleanup, using its current administrator lease and any required fresh
portal consumer proof. Multipart creation also has a 10-minute response bound;
deletion drains that reservation before checking that upload cleanup finished.
A lost response
while creating an R2 multipart upload can leave an unrecorded provider upload;
R2's native incomplete-multipart expiry remains the final cleanup for that
provider boundary. No caller-selected bucket or key enters an API request.

## Deployment and imported media

Create the installation's separate media bucket once:

```sh
npx cf r2 buckets create --name "${TIMDS_WORKER_NAME}-media"
```

The checked-in config binds it as `MEDIA`. Unlike `RELEASES`, this bucket is not
permanently locked: media archive/source deletion removes scoped originals.
Published release objects retain their existing independent locks and audit.

Upload CORS permits the exact `HOST_ORIGIN`, configured `TIMDS_PORTAL_ORIGIN`,
and optional additional exact origins in `TIMDS_MEDIA_ALLOWED_ORIGINS` (JSON
array). There are no wildcard credentialed uploads. CLI requests without Origin
are accepted only with their upload capability. Public GET/HEAD allows public
CORS and supports a single byte range. Private downloads remain no-store.

Imported media reads come only from the source's exact active import stage.
Native overlay rows retain archive/purge audit without rewriting that history.
Existing public URLs remain unchanged. Private downloads and cleanup require an
explicit bucket-to-binding map, for example:

```sh
export TIMDS_MEDIA_LEGACY_BINDINGS='{"example-public-media":"MEDIA_LEGACY_PUBLIC"}'
```

Each configured bucket becomes an R2 binding. Imported object ownership must
match the archived source/client/SHA256 path exactly; unmapped or mismatched
storage fails closed. Source deletion inventories exact asset IDs, stops
pending transfers, removes those originals and verifies absence. Imported
source cleanup renews its existing administrator lease and portal consumer proof
before each removal. No bucket-wide deletion or lock change occurs.

The portal keeps its old media path for sources it still owns. Activated sources
forward media controls using the signed-in person's explicit host OAuth grant.
The source-bound portal facade exposes the same suffixes at
`/api/timds-host/sources/{portalSource}/media`. Old list/create/download handlers
also resolve the current owner; global legacy lists exclude host-owned rows.
A legacy CLI token receives an instruction to use native host OAuth instead of
being converted into another person's identity.

Implementation uses the documented [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
and [Workers RPC request/response streams](https://developers.cloudflare.com/workers/runtime-apis/rpc/).
Live upload/read/archive acceptance is recorded separately after coordinated
deployment; a successful local build does not claim that acceptance.
