# Published artifact backfill dry-run

The actual operational command completed a **read-only** production inventory at
**2026-10-13T11:04:25.695Z**, followed by bounded bundle comparisons. It used the
VPS artifact tree and existing R2 S3 credentials in the child Node environment.
No artifact object, source, pointer, DNS record or credential was changed.
The script and private plan lived under `/tmp`; no production checkout file was
edited. No tests or test harness were added or run.

- Command: [`backfill-published-artifacts.mjs`](../../scripts/backfill-published-artifacts.mjs), default `legacy` mode, source and target `timds-public-assets`.
- Scope: `pierce,wpl,speed`; first publication event bindings plus current pointers.
- Required: **36 releases / 8,555 objects / 548,929,977 bytes**, including 36 public stamps.
- Missing canonical full-path objects: **7,736**. Existing supported aliases remain separate; this count deliberately differs from the earlier path-or-alias baseline count.
- Result: **blocked**, with **17 reports across 11 distinct immutable `bundle.json` keys**. Six keys produced both a source comparison and target comparison report.
- The **47 public stamp/deletion probes** still matched the prior identities and 404 body hashes.
- Nacho's source directory stayed absent, its deletion marker existed, source and destination canonical R2 prefixes remained empty, and old public URLs stayed 404.
- Apply was also ineligible because the original 09:59 inventory had passed the command's one-hour freshness window. A fresh database/storage/public baseline is required before any approved apply.

The sanitized per-release counts and full conflicting hashes are in
[`artifact-backfill-dry-run.json`](artifact-backfill-dry-run.json). The complete
private operational plan is `/tmp/timds69-legacy-backfill-plan.json` on the VPS;
its reviewed identity digest for this historical run is
`08a8c1141eadd9a9ba4ce1c2bee08a245b4fdfd968a4365ced1c7751783c24dd`.
This is evidence of a blocked dry-run, **not approval to apply that plan**.

## Existing bundle representations differ

| System | Conflicting published labels | Local bundle path |
| --- | --- | --- |
| Pierce | 1.3.141, 1.3.142 | `design-system/bundle.json` |
| WPL | 0.1.41, 0.1.42, 0.1.43 | `design-system/bundle.json` |
| Speed.Style | 0.1.4, 0.1.8, 0.1.9, 0.1.10, 0.1.11, 0.1.12 | `bundle.json` |

The comparisons parsed both JSON documents; **none were semantically equal**.
The R2 representations have different `url`, `directory`, `base`, `versioned`
and `files[*].url` values. R2 uses published absolute asset URLs where the local
representation has relative URLs/null bases. Some also contain an added
`designs` field. This is not a whitespace-only difference.

The current WPL public response matches the local bytes:
`d17a7634d574aa1092927d08fbe79020c93c2aa6d2d07c5a4c4f00d8e9e6d98b`.
Its existing R2 bundle is:
`e6fd2addd86940b15cb18a5e0548b5ce93b874c80249445d1637e89259897469`.

The current Speed.Style public response matches the local bytes:
`ee1783edd135c57f7364735c04552627e24e97401b156280c4d9d78c5dacb6a5`.
Its existing R2 bundle is:
`c1ecd9028201cf674bd09a40255c96a2c80e65216bf4932cb4c6e7c4ca58b686`.

Overwriting existing R2 bundle keys would break immutability; choosing those R2
bytes for the old public root would change its current response. A reviewed
mapping and serving-adapter decision must preserve both representations at
separate immutable identities before this conflict can be resolved. The command
has no force-overwrite option and did not silently choose either representation.

See the [operational runbook](../migration/artifact-backfill.md) for the exact
inventory/apply sequence and the separate host `RELEASES` conversion mode. Host
conversion, R2 writes, database import, routing migration, and apply-path proof
remain unperformed.

A later [reconciled dry-run](artifact-backfill-reconciliation.md) preserves both
representations with content-hashed sidecars and explicit serving-map receipts.
It resolves these planned-copy conflicts without overwriting any object; no
apply or routing migration has occurred.
