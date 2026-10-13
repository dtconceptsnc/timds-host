# Production transfer and public cutover — 2026-10-13

At **17:34:47.921Z**, the three production sources were owned by the native host,
Nacho remained deleted, all 14 custom domains routed to `timds-host-69-public`,
and all 77 public comparisons matched. This records transfer and routing;
**retirement deployment and physical legacy runtime cleanup were still pending
final receipts at this checkpoint**. See the [sanitized receipt](production-cutover-2026-10-13.json).

| Source | Final ownership / host stage | Current version | Released versions | History chunks | Media objects / bytes |
| --- | --- | --- | ---: | ---: | ---: |
| Pierce | `host` / `active` | `2026.10.13-1` | 13 | 49 | 279 / 909,094,056 |
| WPL | `host` / `active` | `0.1.43` | 12 | 36 | 549 / 981,447,010 |
| Speed | `host` / `active` | `0.1.12` | 11 | 28 | 208 / 99,768,163 |

Each source retained its original transfer operation and epoch 1 through import,
activation and independent final readback. The JSON records those identities,
stage/activation IDs and export digests. The 113 chunks retain 39 raw version rows
and 39 publication events, including history beyond the 36 unique released
versions. Nacho has only a deleted-source tombstone, bound to its original
completed deletion; activation is forbidden.

Native RELEASES conversion completed at 17:16:21.965Z under plan
`391720997bdf8936fcf2257f646401aa2fb7045f7b4271d187a2bbaf094ffe5b`:
8,591 verified objects, 550,356,950 bytes and 36 releases, with 47 public reads
and 11 retained legacy bundle representations. This completed conversion is
separate from the earlier legacy artifact backfill. Existing release bytes,
source commits and public version pins were preserved.

The user selected immediate cutover without the timed upload drain. The actual
source fences and stop of all 14 inventoried writer units were retained, as were
provider write-capability checks, empty multipart inventories and full hashes of
all **1,036 media objects / 1,990,309,229 bytes**. Three temporary R2 Date locks
protected the exact source media prefixes through **18:22:55Z**; their presence
and unchanged rules were checked before and after hashing, preserving existing
bucket rules. The receipts truthfully record `timedDrainSatisfied=false`; they
do not claim revoked credentials or expired upload URLs. Keep those protections
until their deadlines. `portal-design-system-roots.timer` was permanently
disabled and excluded from later generic writer restoration.

Normal staff OAuth reads through the toolkit resolver succeeded for all three
source/current-version endpoints, without service tokens or operator
impersonation headers. Source identity, current pointer, source commit and
content digest matched each transfer manifest; all three returned
`canRollback=true`.

The 14 custom domains were reassigned under exact hostname/prior-owner guards
using `override_existing_origin`, then independently read back on the new public
Worker. The same Node fetch headers/options used for the baseline matched all
**59 baseline + 18 archived-fixture responses**, including status, byte count and
SHA-256. A separate alternate-user-agent run differed on six HTML responses
because Cloudflare inserted browser analytics. That edge transformation is
recorded separately; the matching baseline requests establish content parity.

## Remaining boundary at this checkpoint

Portal retirement revision `b92bbbf62ae492e72794e708c490c5f900d6a3c2` deployment,
physical legacy unit/runtime cleanup and generic writer restoration still need
their separate final receipts. This transfer evidence does not claim those
operations completed or that issue 69 is closed.

All three current source `timds.json` files still declare
`provider.url=https://timds.com`. For immediate native use:

```sh
timds auth login --portal-url https://timds-host-69.timds.workers.dev
timds start SYSTEM --root EMPTY_DIRECTORY --portal-url https://timds-host-69.timds.workers.dev
```

Continue the explicit `--portal-url` on hosted commands while that manifest
remains unchanged. An existing local session refuses a different host; do not
relabel its identity. Preserve local edits and start a fresh native session.
The durable follow-up is a normal reviewed native source change to `provider.url`
and a **new** release. Do not rewrite imported historical commits/releases or
move existing consumer pins to perform this configuration correction.

Full operator receipts remain in the private transfer directory. No credentials,
signed portal proofs, raw history or private actor details are included here.
No new automated tests or additional UI tests were run for this cutover.
