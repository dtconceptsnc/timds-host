# Native media implementation: prepared, not deployed

Recorded 2026-10-13. Host commit `ab213d7` adds native source-owned media; portal
commit `c03b0b3` adds own-human host OAuth forwarding. Both repositories passed
syntax checks, typecheck and their full builds. No tests were added or run.

The isolated `timds-host-69-media` bucket exists. The media implementation has
**not been deployed**, and no live upload, media archive, legacy object cleanup,
production import, public route change or source cutover was performed for this
step. This is an implementation checkpoint, not an end-to-end acceptance claim.

The user requested a stopping point before rollout. The parent owns the pending
publication FIFO recovery deployment and original batch receipts. Resume from
that reviewed boundary; do not create replacement publications or reset state.

## Resume with released toolkit 0.1.472

After the parent explicitly coordinates deployment, use the existing isolated
fixture (`sourceId` `6ffb48ea-862e-42de-9303-5edcbe8829d5`, system
`timds/cf-preview-source-proof`). Do not use one of the legacy production systems.
The API origin is `https://timds-host-69.ratebucket.workers.dev`; the separate
public origin is `https://timds-host-69-public.ratebucket.workers.dev`.

1. Preserve the installation's deployment environment and secret bindings, add
   the already-created `MEDIA` bucket binding, and deploy the reviewed host
   snapshot. The public companion already forwards native-origin requests to
   `PublicRoots`; its existing service binding must still target this host.
   Do not configure legacy media bucket mappings for this disposable check.
2. Use the operator's existing host OAuth credential through the toolkit's normal
   resolver. Refresh that same grant if needed; do not print/copy token values or
   substitute another identity. For this local task, the parent has the approved
   isolated credential-store location. A standard installation uses the normal
   `timds auth login --portal-url <host-origin>` flow.
3. Create an isolated local checkout with the fixture's system ID. No publication
   or repository push is needed. These commands use the already-installed toolkit:

```sh
host_repo='<absolute-path-to-timds-host>'
proof_root="$(mktemp -d /tmp/timds-media-proof.XXXXXX)"
cli="$host_repo/node_modules/@dtconcepts/timds/bin/timds.mjs"
host_origin='https://timds-host-69.ratebucket.workers.dev'
git -C "$proof_root" init
node "$cli" init --root "$proof_root" --standalone \
  --system-id timds/cf-preview-source-proof --name 'Disposable media proof'
printf 'Disposable TimDS native media proof\n' > "$proof_root/proof.txt"
node "$cli" assets add "$proof_root/proof.txt" --root "$proof_root" \
  --key native-media-proof --title 'Disposable native media proof'
node "$cli" assets publish --root "$proof_root" --portal-url "$host_origin"
```

   A launcher for the task-specific store must resolve the saved token into the
   CLI child environment only (`TIMDS_ACCESS_TOKEN`), or call the toolkit media
   API with `credentialsPath`; it must not rewrite the user's default store.
4. Read the resulting public URL and asset ID from the local toolkit media
   catalog. Verify actual public GET bytes/SHA256, HEAD length/MIME/ETag, and a
   single byte-range GET. Read the authenticated source media list and public MCP
   derived-layer media catalog; both should contain the same ready asset.
5. Stage a second disposable file larger than 32 MiB with the same CLI commands
   and a different logical key, proving real multipart upload and exact ETag
   completion. Verify the complete public bytes against its local SHA256. Keep
   output restricted to public URLs, IDs, counts, statuses and hashes.
6. Through ordinary authenticated API calls, archive each created asset at
   `POST /api/timds/design-systems/<source>/media/<asset>/archive`. Confirm the
   returned audit row is archived, subsequent native public GET is 404, and no
   previously published release/stamp changed. Also exercise a separately
   reserved, unfinished multipart upload through its returned DELETE cancel URL
   and confirm durable cancellation (poll while `pending:true`).
7. Record sanitized upload IDs, asset IDs, byte counts, hashes, methods and
   response statuses in a new live receipt. If a step fails, preserve its exact
   upload/asset identity and inspect the durable row; do not manufacture a pass
   or erase its audit. Remove only the disposable local checkout after retaining
   the acceptance receipt.

## Known limits and cleanup boundaries

The [media API](../api/media.md) documents the actual native 32 MiB single / 16 MiB
part / 10,000-part limits. Transfer attempts are not taken over after a worker
crash; cancel and create a fresh upload. Completion is replayable. Full-object
verification is bounded. Provider multipart allocation can have an unknown
outcome before the returned ID persists; native R2 incomplete-upload expiry is
the final cleanup at that provider boundary.

Source deletion inventories exact asset IDs and upload receipts. It preserves
locked release objects while purging only source-owned media originals. Imported
originals need explicit bucket bindings and the existing verified consumer fence
before deletion; no bucket listing guesses ownership. Public legacy media has
not been migrated or deleted by this change.
