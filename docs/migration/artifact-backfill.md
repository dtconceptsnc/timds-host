# Published artifact backfill

`node scripts/backfill-published-artifacts.mjs --help` describes the operational
command. It defaults to a read-only inventory. It never changes a database row,
publication pointer, DNS record, domain, repository, or source. It never deletes
an object. Known public-bundle representation differences are preserved at new
content-hashed sidecar keys, never written over the existing R2 representation. Do not apply until host acceptance has passed and the operator has
reviewed a fresh inventory and its exact plan digest.

## Two distinct destinations

- **`--mode legacy` (default)** fills the existing canonical public-assets keys:
  `<systemId>/artifact/v/<version>/<exact-artifact-path>`. Select the current
  public-assets bucket as both source and target to backfill it in place. Every
  existing object at a required path is downloaded and SHA-256 checked. The local
  `.timds-artifact.json` is internal metadata and is never uploaded as the public
  stamp. Existing public stamp bytes are preserved; a missing stamp uses the
  current portal's compact public stamp serialization.
- **`--mode host-releases`** is a separate, explicit conversion to the host
  `RELEASES` bucket under `sources/<sourceId>/v/<version>/`. It creates the
  native SHA-256 file manifest, pretty-printed public stamp, and final
  `.timds-release.json` receipt expected by `src/publication/releases.mjs`.
  This mode enforces the host's file/count/size limits. Its plan includes each
  `artifactRef` and exact stamp for the later database import. It does not
  perform that import, create publication events, or make releases public.

Legacy keys are completed **before** host conversion or routing migration.
Neither mode edits unversioned objects or media. Retained R2 labels that have no
first publication event are not inferred to be published versions. All existing
objects under each selected published version are hashed; unrecognized extra
objects remain in place and are recorded for review.

The local full path is canonical. Existing entry-directory aliases are checked
against the corresponding local bytes and retained. The command does not invent
aliases or overwrite a conflicting alias. A differing root `bundle.json` has one
narrow reconciliation: its exact first-event pinned public response must equal
the local bytes; the current public response must also match for a current
release. It then preserves those bytes at a content-hashed sidecar and records
both representations. Every other differing file or ambiguous local mapping
still stops with a collision for operator review. Missing consumer
`bundle.json` / `bundle/*` files may be recovered from their existing canonical
R2 keys, matching the portal's documented consumer-bundle fallback. Other extra
R2 files are not promoted into a release by assumption.

## Inputs and credentials

Run on the host that has the artifact tree, or against an independently verified
copy of that tree. Required inputs are explicit: baseline JSON, artifact root,
source selection, source and target buckets, environment prefixes, installed S3
SDK location, and output plan path. There are no production endpoint, bucket,
source, or credential defaults.

For each `--*-env-prefix PREFIX`, provide these values in the process environment:

- `PREFIX_ACCOUNT_ID`, or `PREFIX_ENDPOINT` containing the account's HTTPS R2 S3
  origin.
- `PREFIX_ACCESS_KEY_ID` (existing `PREFIX_ACCESS_KEY` alias is also accepted).
- `PREFIX_SECRET_ACCESS_KEY`.

Do not pass secrets in command arguments. `--sdk-root` identifies an existing
installation of `@aws-sdk/client-s3`; it does not install dependencies. On the
current VPS the portal's SDK and existing `CLOUDFLARE_*` credentials can be reused
by loading `.env.server` into the Node child process. No credential is created,
printed, copied into the plan, or stored in receipts. Outputs contain IDs, object
paths, counts, hashes, and sanitized failure codes. Plan and receipt files are
written with mode `0600`; they contain release metadata but no artifact bodies
apart from the public/generated stamp and manifest.

The baseline must report unchanged source rows around its inventory. It must
include local metadata, version rows, append-only events, first-label bindings,
and public response identities in the format of
[`migration-baseline.json`](../evidence/migration-baseline.json). A dry-run may
inspect an older baseline and reports `baselineFresh:false`; apply rejects a
baseline older than one hour. Recapture immediately before review/apply. The
command additionally rechecks current and historical public stamp identities and
the deleted source's 404 hashes. These checks do not replace a coordinated
migration window or fresh database inventory.

## Concrete legacy inventory command

These paths and selections come from the captured production inventory. Copy
the script and a **freshly recaptured** baseline into an operator scratch
location first. The example writes only the local plan; it performs no R2 PUT.

```sh
cd /var/www/portal.dtconcepts.net
/root/.nvm/versions/node/v25.4.0/bin/node --env-file=.env.server \
  /tmp/backfill-published-artifacts.mjs \
  --baseline /tmp/migration-baseline-fresh.json \
  --artifact-root /var/www/portal.dtconcepts.net/var/design-system-artifacts \
  --sources pierce,wpl,speed \
  --source-bucket timds-public-assets \
  --target-bucket timds-public-assets \
  --source-env-prefix CLOUDFLARE \
  --target-env-prefix CLOUDFLARE \
  --sdk-root /var/www/portal.dtconcepts.net \
  --plan /tmp/timds69-legacy-backfill-plan.json
```

Inspect the plan's `identity.releases` and `observations.conflicts`, plus every
retained unknown object and alias. The frozen identity covers the baseline hash,
account/buckets, mode, exact sources, first-event bindings, local entry paths,
file hashes, supplementary R2 bytes, target keys, serving-map receipts, retained legacy bundles and public byte
proofs. The plan SHA-256 excludes
whether an object is currently missing, so a partially completed copy can resume.
It does include the required exact bytes and destinations.

After explicit operator approval, repeat the **same** command with:

```sh
  --apply \
  --approve-plan-sha256 <exact-reviewed-planSha256> \
  --receipt /tmp/timds69-legacy-backfill-receipt.json
```

Apply inventories again, requires the same plan digest, refuses all collisions,
and uses conditional `If-None-Match: *` writes with the expected SHA-256 checksum.
It downloads and hashes each resulting object before recording success. Existing
objects are verified again on resume; the receipt is evidence, not an authority
to skip verification. Content files and sidecars precede the stamp, and the serving-map receipt (or
host conversion's native manifest receipt) is last. Retained legacy bundle bytes
and the public bundle responses are verified again before and after copying. A failed run can leave partial **immutable** content
objects; repeating the approved command resumes safely. There is no rollback
that deletes completed immutable objects.

For host conversion, first complete and review the legacy receipt. Run a new
dry-run with `--mode host-releases`, a different target bucket/environment
prefix and a new plan/receipt path. Review its digest separately. Do not reuse
legacy approval or blindly treat the converted objects as imported database
versions. Existing host objects must also carry matching `sha256` metadata;
metadata mismatches are collisions and are never repaired in place. The native
release stores the authoritative local bundle at its local file path; no legacy
sidecar is written in host conversion mode.

## Deletion and publication invariants

Nacho's missing database rows, local directory absence, deletion marker, empty
canonical artifact prefix, and existing public 404 response hashes are checked.
It cannot be selected for copying. Its corresponding destination prefix must
also remain empty. Checks run during inventory and before and after apply.

First publication events are ordered by `created_at`, then `id`. Their exact
version-row ID, digest and source commit define pinned releases forever. A
current pointer with the same label but different bytes is rejected. The command
does not choose whichever version was published most recently.

## Serving dependency still to migrate

A complete legacy R2 tree makes the required bytes available remotely. The
current portal public-roots handler still requires local metadata/tree and only
falls back to R2 for consumer bundles. Its current/pinned HTML rewriting,
meta-refresh entry resolution and synthesized legacy text also differ from
serving raw R2 bytes. The subsequent routing adapter must preserve those
behaviors, use the captured entry path/manifest, and pass fresh public HTTP
hash/status comparisons. This command alone does not establish VPS-independent
serving or authorize a domain cutover.

No production copy or cutover is implied by a successful dry-run. Preserve the
plan/receipt and record actual verification timestamps and failures in evidence.

The first read-only run found existing bundle representation conflicts; see
[the original evidence](../evidence/artifact-backfill-dry-run.md). The subsequent
reconciliation preserves both representations using the mapping below. It does
not reuse approval from the original blocked plan; a fresh baseline and review
of the new exact plan digest are required before any apply.


## Immutable serving-map contract

For an approved legacy reconciliation, the raw public bundle uses:

```txt
<systemId>/artifact/.timds-served/sha256/<public-byte-SHA256>/bundle.json
```

The existing `<systemId>/artifact/v/<label>/bundle.json` is retained byte-for-byte.
When the local tree also has a nested `design-system/bundle.json`, that full path
is filled normally and the root public `/bundle.json` explicitly uses the
sidecar. When the local path itself is `bundle.json`, the file mapping also uses
the sidecar so no conflicting canonical object is overwritten.

Each release has an immutable, content-hashed JSON receipt:

```txt
<systemId>/artifact/.timds-serving/<sourceId>/v/<label>/<contentDigest>/<receipt-SHA256>.json
```

The plan and completed apply receipt record its exact key, size and SHA-256.
The serving-map body includes:

- `sourceId`, `systemId`, `version`, `contentDigest`, `sourceCommit`, the exact
  `firstPublicationEventId` and `versionId`, and `entryPath`.
- `files`: every local artifact-relative path with its exact R2 `key`, `mode`,
  `contentType`, `size` and byte `sha256`.
- `publicOverrides`: the proven root bundle path, exact target `objectKey`,
  content hash/size/type, original retained R2 key/hash/size, and anonymous pinned
  and current public byte proofs.
- `behavior`: files and consumer bundles are byte-preserving. Legacy HTML
  rewriting, entry meta-refresh resolution, and missing legacy text synthesis
  remain explicit serving-adapter requirements.

The adapter must first resolve the authenticated catalog's current published
version for an unpinned URL, or the earliest publication event for a pinned
label. It then loads **that imported version's explicit serving-map reference**,
verifies the receipt hash and all identity fields against the resolved version
and event, and validates all object keys belong to the source's expected
artifact namespace. A sidecar key's embedded hash must equal the file hash.
Receipt presence, R2 listing order, latest version timestamps and repeated label
names never select a public version. Missing/mismatched receipts fail closed;
there is no fallback to an older local directory or to a different R2 bundle.

For `/bundle.json`, use the declared override before ordinary entry-directory
lookup and serve its exact bytes. For other files, reproduce the original
entry-directory/file lookup using the receipt's file map. Validate object
size/hash, preserve MIME and conditional response behavior, and apply the legacy
HTML/CSS/JSON rewriting only where the original handler did. Raw artifact hashes
do not certify rewritten HTTP responses; compare the fresh public HTTP baseline
before any domain cutover. Native host `RELEASES` receipts already bind the
separate source/version namespace; import the original first-event/current
bindings and exact native `artifactRef` rather than consulting legacy key names.

The [actual reconciliation dry-run](../evidence/artifact-backfill-reconciliation.md)
verified all 11 affected pinned public bundles (plus the two affected current
bundles), with zero unresolved collisions. It made no writes and still requires
a fresh baseline and reviewed plan before apply.

The native compatibility implementation and exact import/routing metadata are
documented in [legacy public-root compatibility](legacy-public-roots.md). The
new plan separates original local files from R2-only bundle fallbacks and records
the latter's actual ContentType. Existing plans need recapture/review before use.
