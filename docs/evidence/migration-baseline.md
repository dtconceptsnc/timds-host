# Migration baseline

Captured **2026-10-13T09:59:36.606Z–2026-10-13T09:59:43.118Z** from production Supabase,
the VPS artifact store and R2; public reads followed at
**2026-10-13T10:00:45.402Z–2026-10-13T10:00:49.367Z**.
This is discovery evidence, not a migration or cutover. **Recapture immediately
before migration.** Full identities, events, first-label bindings, local trees,
R2 counts and all 59 HTTP response hashes are in
[migration-baseline.json](migration-baseline.json).

## Scope discrepancy

The four systems named by the tracked #56 migration map are no longer four live
systems. **Pierce, WPL and Speed.Style are active and published; Nacho was deleted.**
The old Nacho source ID `af5ad825-f52a-41be-80ce-38619dfc659c` has no source,
version or publication-event row. Its local artifact directory is absent and
`.deleted-sources/<source-id>` exists. Its canonical R2 artifact prefix has no
objects; primary and mirror public URLs return 404. Do not recreate it or turn
the existing 404s into a new migration target without an explicit product decision.
The conformance fixture and #60 session/runtime resources were excluded.

Source rows were equal before and after the database/storage inventory. This
is not an atomic database/filesystem/R2 snapshot; live publication may advance
after capture.

## Source and publication identities

| System | Source ID | System ID | Current version |
| --- | --- | --- | --- |
| pierce | f7cfb345-391a-40ba-80f4-fc08359696bb | pierce-law-group/core | 2026.10.13-1 |
| wpl | 5b69a328-c6a2-4a40-aa0c-0c7588ae4c0c | wpl-design-system/core | 0.1.43 |
| nacho | af5ad825-f52a-41be-80ce-38619dfc659c | timds/69d1d810-17f6-4c67-ae22-7e2d6a1b169e | deleted |
| speed | d9465b2e-3c19-48de-a3ee-7d1c4770c8ad | timds/3afe701d-dfb2-4071-beaf-5094aeb3691b | 0.1.12 |

- **pierce:** source commit `3c309261e00cb21ed87d98b79ac803e508ca740a`; content digest `064fdd6a99eaefbdd54ec96368e6e48749450dbc9d58c3d5fa0d313fb2b046ab`.
- **wpl:** source commit `479259b49e6220da08739b96b6b926b1831ec1c8`; content digest `a1fda84d5f01e59502b4302ceecbd1864fe93de6db64833fabb6493df8ea044b`.
- **speed:** source commit `175d267cd40e2dc89fb6bcca8adfa68d691f3ade`; content digest `b2c6ffc96dc218acb09933c5838c3b4b100265872e275bea64d6628061f1e495`.

Artifacts namespace, repository name and immutable repository ID are retained in
the JSON source record. This capture did not mint a Git capability or clone a
repository. The current publication commit is separate from mutable source-main
head; the latter was not read.

## First-event pinning

Pinned URLs resolve the earliest publication event ordered by `created_at` then
`id`, not the latest version row's `published_at`. Each JSON
`firstLabelBindings` record preserves its event ID, version-row ID, label, digest,
source commit and timestamp. All **36 first-label public stamps** returned 200
and matched these exact database bindings.

| System | Stored versions | Publication events | First-label bindings | Labels |
| --- | ---: | ---: | ---: | --- |
| pierce | 15 | 16 | 13 | 1.1.0, 1.2.1, 1.3.124, 1.3.128, 1.3.132, 1.3.133, 1.3.135, 1.3.136, 1.3.137, 1.3.140, 1.3.141, 1.3.142, 2026.10.13-1 |
| wpl | 13 | 12 | 12 | 0.1.0, 0.1.8, 0.1.9, 0.1.26, 0.1.28, 0.1.34, 0.1.35, 0.1.39, 0.1.40, 0.1.41, 0.1.42, 0.1.43 |
| nacho | 0 | 0 | 0 | none |
| speed | 11 | 11 | 11 | 0.1.0, 0.1.2, 0.1.3, 0.1.4, 0.1.5, 0.1.7, 0.1.8, 0.1.9, 0.1.10, 0.1.11, 0.1.12 |

Repeated labels/events and non-published version rows must remain distinguishable.
R2 also contains labels with no first publication binding; object existence does
not grant a label a public release. Preserve event IDs/order and all recorded
pointers rather than deriving history from bucket contents.

## Local artifacts and R2 availability

The local artifact root is `/var/www/portal.dtconcepts.net/var/design-system-artifacts`.
There are **39 retained digest trees / 9,094 files / 599,449,364 bytes**, excluding
the small internal metadata files. Current pointers and first-label bindings
require **36 trees / 8,519 files / 548,921,270 bytes**. Every required tree exists;
all metadata file counts/sizes match filesystem counts, and no non-regular
entries were found.

| System | Retained local trees | Local bytes | Required trees | Required bytes | R2 artifact objects | R2 artifact bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| pierce | 15 | 467842392 | 13 | 417346594 | 1894 | 117740733 |
| wpl | 13 | 110679078 | 12 | 110646782 | 517 | 30829910 |
| nacho | 0 | 0 | 0 | 0 | 0 | 0 |
| speed | 11 | 20927894 | 11 | 20927894 | 186 | 8664457 |

R2 list access succeeded for bucket `timds-public-assets`, with no truncated
listing. Artifact keys use `<systemId>/artifact/`; public object delivery is
`https://design-systems.timds.com`. These inventories include both versioned and
unversioned objects and are not directly subtractable from local totals.

Across required release trees, **6,919 local files / 449,126,440 bytes** have no
matching versioned R2 object by canonical path (including supported entry-root
alias) and size:

| System | Files without matching versioned object | Bytes |
| --- | ---: | ---: |
| pierce | 4312 | 341884130 |
| wpl | 2052 | 91323678 |
| nacho | 0 | 0 |
| speed | 555 | 15918632 |

This is a backfill inventory, not a cryptographic equivalence check. R2 bodies
were not downloaded. Matching path/size is only a candidate match; migration
must hash exact bytes before treating it as already copied. Current Pierce has
705/705 files matching versioned key and size; current WPL matches 108/300 and
Speed.Style 21/87. Most older releases have no complete R2 artifact copy. Public
serving still requires the local artifact metadata/tree even when a consumer
bundle can fall back to R2.

R2 media was enumerated separately under each active source's client/source
prefix: Pierce 280 objects / 909,098,152 bytes, WPL 549 / 981,447,010 bytes,
Speed.Style 208 / 99,768,163 bytes. Total: **1,037 objects / 1,990,313,325 bytes**.
Nacho media is unknown because its former client mapping is absent; an empty
artifact prefix does not establish that all former media was deleted.

## Twelve primary public reads

The baseline selects current root HTML, `bundle.json` and
`.timds-artifact.json` on the primary domain for each original mapped system.
Nine responses are 200; the three Nacho responses preserve its existing 404.
The hash below is SHA-256 of the HTTP response bytes, distinct from the semantic
`contentDigest` inside a publication stamp. Full response metadata and hashes
for mirrors, current-label pinned bundles and all historical pinned stamps are
in JSON. All live current/mirror stamps matched their database pointers; mirror
roots also returned 200.

| URL | HTTP | Bytes | Response SHA-256 |
| --- | ---: | ---: | --- |
| https://plg-ds.timds.com/ | 200 | 34049 | `f6891c4c7354340a33a385ce246b53d2b72c0685c1d8234098998718cb0bc668` |
| https://plg-ds.timds.com/bundle.json | 200 | 66439 | `236130268c847ad53410adfb8a942a696878600f8451c9b9628977233d0ea297` |
| https://plg-ds.timds.com/.timds-artifact.json | 200 | 241 | `a4520b28b882daaa954f693eb4632487b90bf345751be7a0ef52272cbb121789` |
| https://wpl-ds.timds.com/ | 200 | 16797 | `87c01afb43c7cea4958ec191e4fddb0cac8461f03b5e6e975aaca915d3ca405e` |
| https://wpl-ds.timds.com/bundle.json | 200 | 30073 | `d17a7634d574aa1092927d08fbe79020c93c2aa6d2d07c5a4c4f00d8e9e6d98b` |
| https://wpl-ds.timds.com/.timds-artifact.json | 200 | 236 | `5a6079c3a51852992e391cb71bc5ee129bba880b7375115608c342a917646cf0` |
| https://timds-69d1d810-17f6-4c67-ae22-7e2d6a1b169e-ds.timds.com/ | 404 | 24 | `52e5b633da7e0e86127c5270d4f50e35db798e113bb16dd3348a1eca1c525bd3` |
| https://timds-69d1d810-17f6-4c67-ae22-7e2d6a1b169e-ds.timds.com/bundle.json | 404 | 24 | `52e5b633da7e0e86127c5270d4f50e35db798e113bb16dd3348a1eca1c525bd3` |
| https://timds-69d1d810-17f6-4c67-ae22-7e2d6a1b169e-ds.timds.com/.timds-artifact.json | 404 | 24 | `52e5b633da7e0e86127c5270d4f50e35db798e113bb16dd3348a1eca1c525bd3` |
| https://ds.timds.com/ | 200 | 16689 | `88bac1a87aa9cb8032c7d05e14ebd91ef2b2c601e3de499155292e8bc8b6141d` |
| https://ds.timds.com/bundle.json | 200 | 4729 | `ee1783edd135c57f7364735c04552627e24e97401b156280c4d9d78c5dacb6a5` |
| https://ds.timds.com/.timds-artifact.json | 200 | 256 | `6428f00703c7378b9161e9e0d39beb174d7723d4bfe2cb65d6b11e683c0e1121` |

The mirror domains are `plg-ds.speed.style`, `wpl-ds.speed.style`,
`ds.speed.style`, and the deleted
`timds-69d1d810-17f6-4c67-ae22-7e2d6a1b169e-ds.speed.style`.
The supplemental set yielded 45 additional 200s and two expected Nacho 404s.
No response bodies or private source files were saved in this evidence.

## Capture and recapture method

The inventory read only explicit metadata columns from
`design_system_sources`, `design_system_versions` and
`design_system_publication_events`; no auth, token, session, grant, Request or
execution-job rows were exported. Existing `.env.server` credentials were loaded
only into the SSH child Node process via `--env-file`. It counted regular local
artifact files and used the existing S3 client for bounded `ListObjectsV2` calls.
No credential was created, printed, copied or changed. Public GETs were anonymous,
limited to 5 MiB each, and reduced to status/headers/hash/stamp identity.

Before migration, repeat this inventory, compare all pointer and first-label
bindings, enumerate any new required digests, and hash each local/R2 artifact
file. Capture these public responses again immediately before routing changes
and compare after cutover. Preserve the deleted Nacho state unless its scope is
explicitly changed. No bulk copy, mutation or cutover was performed here.
