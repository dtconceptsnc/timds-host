# Immutable bundle reconciliation dry-run

The follow-up **read-only** production inventory completed with **zero unresolved
collisions**. Root approved the reconciliation design for implementation and
inventory only. It does **not** approve an R2 copy, database import, or domain
cutover. No writes, deletes, pointer changes, new credentials, tests, or test
harnesses were performed.

The original [blocked dry-run](artifact-backfill-dry-run.md) remains evidence of
11 existing bundle representations that differ from the local/public bytes. The
revised command keeps every existing R2 bundle unchanged and uses a new
content-hashed sidecar for the corresponding public bytes:

```txt
<systemId>/artifact/.timds-served/sha256/<public-byte-SHA256>/bundle.json
```

Each of the 11 sidecars was matched against an actual anonymous GET of its
first-event pinned public bundle. Current WPL and Speed.Style were additionally
matched against their unpinned public bundles: **13 exact byte proofs**. All
47 prior public identity/deletion probes also matched. This establishes which
representation the serving adapter must use; the command never selects between
representations from a label name or bucket listing.

The proposed immutable copy contains:

- **36 releases**, including 11 reconciled public bundles.
- **8,596 objects / 551,748,498 bytes**, including 36 serving-map receipts and public stamps.
- **7,783 missing objects**; existing objects were read and SHA-256 verified.
- **Zero unresolved collisions**; any other file collision or ambiguous bundle mapping still fails closed.
- Nacho unchanged: source directory absent, deletion marker present, canonical source/target artifact prefixes empty, public URLs 404 with their original response hashes.

The exact timestamps, release/event/version identities, retained R2 bundle
hashes, sidecar keys, public proofs and all 36 proposed receipt references are in
[`artifact-backfill-reconciliation.json`](artifact-backfill-reconciliation.json).
The private full plan is `/tmp/timds69-legacy-reconciled-plan.json` on the VPS.
Its identity digest for this inventory is:

```txt
fa60320967ed26ae9931e8994285d2185cbe2cbb575094382552bea32da45f59
```

**Apply remains ineligible:** the input database/storage baseline was older than
one hour. Recapture the baseline immediately before migration, rerun inventory,
review the resulting new exact digest and reconciliation report, and obtain
root's apply decision. Do not reuse this historical digest as an apply approval.

## Serving adapter decision

The proposed serving-map receipt is content-hashed and binds source/system IDs,
label, semantic digest, source commit, first publication event/version IDs,
entry path, and every file's object key, mode, MIME, size and SHA-256. The receipt
is written last, after all referenced content has been verified. Import its
explicit reference into the corresponding published version.

An old root's unpinned URL resolves the current database pointer; a pinned label
resolves its first publication event. The adapter then verifies that exact
version's receipt and its byte hashes. Its `/bundle.json` override uses the new
sidecar. Existing rewritten R2 bundle URLs continue to address the original
immutable R2 object. It must never fall back from a missing sidecar to the
rewritten canonical bundle or infer a version from a newer receipt.

Raw files and bundles are byte-preserving. Legacy HTML/CSS/JSON URL rewriting,
root meta-refresh handling and missing legacy text synthesis remain explicit
adapter requirements. Those transformed HTTP responses need comparison against
a fresh public baseline before routing changes; raw artifact hashes alone do not
prove that behavior.

The separate `host-releases` mode places authoritative local/public bytes in its
own `sources/<sourceId>/v/<label>/` namespace with the host's native manifest and
stamp. It leaves all legacy bundles unchanged and records their provenance.
Host conversion has not been run. Its import must preserve first-event/current
bindings and native `artifactRef`; it cannot use legacy bucket keys as version
authority.

The [runbook](../migration/artifact-backfill.md#immutable-serving-map-contract)
describes the adapter contract and explicit inventory/apply sequence. The apply
path has not been exercised on production or a disposable bucket.
