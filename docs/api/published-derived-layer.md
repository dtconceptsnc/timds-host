# Published derived layer for retained readers

The anonymous public MCP and authenticated read MCP expose `read_derived_layer`
with `{systemId, version?, metadataOnly?}`. This is a read-only tool, not a source
export. It captures `publicVersion` once, binds the exact source and publication
version, and reads the derived documents from that immutable R2 release.

The structured result has `schemaVersion: 1`, public `source` identity,
`release: {id, versionLabel, sourceCommit, contentDigest, firstPublicationEventId}`,
`currentVersion`, `versions`, `versionsLimit: 100`, `publicRoot`, `publicUrls`,
`entryPath`, and (unless metadataOnly) `layer` and `media`. `versions` lists at most
100 first-publication labels; an explicit historical label resolves directly,
without depending on that listing. Current and first-label releases can differ
for imported same-label republications; their URL bases are not interchangeable.

The layer contains index, tokens, brand, llms, formats, designs, changelog and
bundle documents from beside the captured artifact entry, capped at 8 MiB of
raw document bytes. Artifact-local media normalization reads only that immutable
tree, never fetches authored URLs, and is bounded to 1,000 references. Imported
media comes only from the source's exact active import stage, ready/public rows,
and an explicit public-field allowlist. It is capped at 1,000 records with
`truncated` and `limit`. Native sources without imported media return null.

No authored source tree, storage reference, provider secret, grant, private media
or raw import history is returned. Missing/deleted sources fail before reading
media. Failed tools return `isError` and bounded
`structuredContent.error.statusCode` (400/404/409 or generic503), never provider
error bodies. The portal uses this to distinguish absence from failed guidance
and never falls back to a stale artifact.

The portal keeps its own Client authentication and reports gaps into its existing
Approvals intake; it calls this public tool without forwarding the caller's bearer
or cookies. Human host draft authorization is a separate interface.

Native browser HTML/CSS responses rebase standalone root-relative links beneath
`/systems/<encoded-system>/` or its `/v/<label>/` prefix. Their ETag and length
reflect the rendered bytes. Stored release bytes, provenance digests and binary
consumer bundle assets retain their original identity. Public native URLs remain
on the separate companion origin.

Native sources are identified by a positive `provision_operations` receipt before
looking for imported media. They do not depend on optional import migrations.
Imported sources have no native provision receipt and still require the exact
active import-stage table; missing import authority fails closed.

Native `bundle.json` has scoped absolute manifest/directory/file URL fields;
its declared file paths, byte counts and hashes are preserved. The physical
`bundle/*` files are never rewritten. A pinned manifest advertises its immutable
version directory; a current manifest does not claim that a same-label historical
release has identical bytes. The MCP can advertise the version directory when
its captured first-label descriptor matches, or for an explicit historical read.
Guidance/design/media URL fields in MCP documents use that same captured base.
