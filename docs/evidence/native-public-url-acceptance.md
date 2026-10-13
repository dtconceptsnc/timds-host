# Native published URL acceptance — 2026-10-13

Actual published fixture: `timds/cf-preview-source-proof`, source
`6ffb48ea-862e-42de-9303-5edcbe8829d5`, label `2026.10.13-2`.
Public origin: `https://timds-host-69-public.ratebucket.workers.dev`.

The live `/systems/timds%2Fcf-preview-source-proof/web/spacing/` HTML was fetched
anonymously and contained root-relative stylesheets and navigation (`/tokens.css`,
`/styles/system.css`, `/web/spacing/`, `/brand/typography/`). These escaped the
source prefix. The native presentation adapter now rewrites HTML/CSS URLs beneath
the current source or exact pinned version, and computes ETag/length from that
representation. Bundle files, binary files, stored R2 objects and release digests
are unchanged. The legacy hostname adapter is unchanged.

Applying the adapter to those actual published bytes with the pinned label
produced17 scoped stylesheet/navigation attributes under
`/systems/timds%2Fcf-preview-source-proof/v/2026.10.13-2/`; the local review artifact
was `/tmp/timds69-native-spacing-scoped.html`. It is an actual-artifact rendering
check, not a generated fixture or new test suite.

The actual published bundle manifest was rendered with scoped absolute URL
fields, then both resulting immutable public file URLs were fetched anonymously:

| File | HTTP | Bytes | SHA256 |
| --- | --- | --- | --- |
| `bundle/dist/styles/system.css` | 200 | exact manifest match | exact manifest match |
| `bundle/dist/tokens.css` | 200 | exact manifest match | exact manifest match |

Toolkit0.1.471 `resolvePublishedBundle` already handles raw manifests by resolving
files beside the pinned manifest when `base` is null. The new served manifest
also makes its own `url`, `base`, `directory`, `versioned`, and file URLs usable by
ordinary URL resolvers and MCP clients, without changing declared file hashes.
Current manifests do not claim a same-label historical copy is byte-identical;
pinned manifests identify their exact version directory.

An actual anonymous `read_derived_layer` on Worker
`04d8b165-67ab-463b-bac8-3b2739ec7471` returned503. Read-only D1 schema inspection
confirmed import migration0002 had not been applied. The new helper positively
identifies native sources by their existing `provision_operations` receipt and
skips optional import-media lookup only for those sources. Imported sources still
require their active import stage and fail closed if that authority is unavailable.
This corrected path and URL follow-up are locally syntax/typecheck/build verified;
live recheck awaits the next coordinated deployment. No migration, source write,
domain routing or deploy was performed by these reads.

The actual `index.json` page directory uses extensionless URLs such as
`/brand/color`. Native serving now resolves those against the same captured
release: a directory index redirects to its scoped trailing-slash URL; an
existing `.html` page is served with HTML MIME. No cross-source fallback or
second pointer resolution is introduced.
