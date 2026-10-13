# Legacy public-root compatibility

`src/public/legacy.mjs` preserves the portal public-roots behavior for explicitly
imported sources. The companion Worker uses a reviewed hostname-to-source UUID
map; the API service independently requires the same hostname in the current
source's import metadata. Neither component derives a slug from a system name,
lists R2 to select a version, or falls back to a portal/VPS origin.

No existing domain is routed by this change. The companion's default legacy map
is empty. The implementation and read-only rehearsal do not authorize an import,
R2 copy, domain change, or cutover.

## Frozen metadata

The import mapping must provide the source's exact public hostnames:

```json
{
  "legacy_public_roots": {
    "schemaVersion": 1,
    "behavior": "portal-public-roots-v1",
    "hosts": ["<existing-primary-host>", "<existing-mirror-host>"]
  }
}
```

For each imported published version, copy `release.legacyPublic` from the
**completed host-releases conversion's frozen plan** into
`version.legacy_public`:

```json
{
  "schemaVersion": 1,
  "behavior": "portal-public-roots-v1",
  "firstPublicationEventId": "<original-first-event-uuid>",
  "artifactManifestDigest": "<SHA-256-of-native-release-receipt-bytes>",
  "entryPath": "<original-artifact-entry-path>",
  "localPaths": ["<original-local-artifact-relative-path>"],
  "bundleFallbacks": [
    {"path": "bundle/<existing-supplement>", "contentType": "<actual-R2-ContentType>"}
  ]
}
```

The backfill plan now records the original local paths separately from consumer
bundle files that the portal loaded from R2 only when no local file matched.
Fallback MIME is the actual R2 ContentType, or the portal's exact extension
fallback if that metadata was absent. These lists must partition the native
release manifest without duplicates. The entry path must be a local file and
match the version's artifact metadata. A new plan digest and approval are
required after adding these fields; historical dry-run digests are not reusable.

The importer verifies the native receipt digest and physical files. Public reads
recheck the receipt's source, label, semantic digest, commit, stamp and exact
manifest digest, and compare the declared first event to the coordinator's
append-only earliest event for that label. Every requested file is checked for
size and SHA-256 against that receipt. A mismatch fails closed. Newly published
native versions of an imported source use their own manifest and entry path;
there is no old-storage fallback.

## URL and response behavior

- Unpinned URLs select the coordinator's current pointer. `/v/<label>/` and the
  historical `/releases/<label>/` alias select the earliest publication event for
  the label. Both pinned forms rewrite internal root-relative URLs using `/v/`.
- Lookup checks the original entry directory before the artifact root, with the
  portal's extensionless `.html` and `/index.html` candidates.
- Consumer `bundle.json` and `bundle/*` bytes are never rewritten, including
  entry-directory aliases and full artifact paths. Reconciled native releases
  contain the authoritative local/public bytes. The old canonical rewritten R2
  objects and media URLs are retained separately by the migration procedure.
- Current entry pages resolve at most eight local meta-refresh hops. External,
  cyclic and invalid targets fail closed. Relative attributes on a resolved
  landing page are rebased exactly as the portal did. Pinned HTML retains its
  meta-refresh page and receives the usual version-prefix rewriting.
- Pinned HTML, CSS, non-bundle JSON, plain text and Markdown use the portal's
  existing rewrite rules. The provenance aliases use compact JSON for current
  roots and the historical two-space JSON formatting for pinned roots.
- Missing `llms.txt` and `llms-full.txt` are synthesized from the original local
  HTML/Markdown tree with the same text extraction and ordering. R2 supplements
  do not silently become synthesis inputs.
- Success retains CORS, content MIME, length, byte-derived ETag, viewer sandbox
  CSP, no-referrer policy, five-minute current cache and one-year pinned cache.
  GET, HEAD and exact If-None-Match behavior follow the portal handler. The
  companion handles OPTIONS and strips incoming browser credentials.
- Unlisted hosts return the historical `Design System not found.` 404. The deleted source's
  hosts remain unlisted, with no imported source or artifact namespace.

## Routing preparation

After a separately approved migration and source activation, provide a reviewed
map to the companion build environment:

```sh
export TIMDS_LEGACY_PUBLIC_HOSTS='{"<primary-host>":"<source-uuid>","<mirror-host>":"<same-source-uuid>"}'
```

Preserve `TIMDS_WORKER_NAME` and `TIMDS_PUBLIC_ORIGIN` from the installation's
normal deployment environment. Deploying the companion does not register
custom domains or change DNS. Domain attachment/routing is a separate operator
step after fresh comparison and ownership checks. Keep deleted sources out of
the map. The normal public origin still provides `/systems/...` and `/mcp`.

## Verification so far

The actual renderer was run read-only against the three existing production
artifact trees and compared with 37 anonymous public GETs. All statuses, bodies
and MIME types matched, including the primary 12 URLs, mirrors, historical roots,
missing reference-text synthesis, and representative CSS/JSON. See
the sanitized receipt (private operational record).

That rehearsal used authoritative local files, because no host-release copy or
import was authorized. It does **not** exercise R2 manifest verification, the
imported authority gate, converted bundle fallback MIME, or a deployed custom
hostname. Those must pass on converted/imported data before cutover. The host
and companion compile successfully; no test files or production copy were made.
