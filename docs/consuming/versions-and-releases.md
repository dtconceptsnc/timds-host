# Versions, releases and the current pointer

## Labels

A release label is its UTC day and a number for that day, `YYYY.MM.DD-N`,
counting up within the day. Systems released before the scheme carry
`MAJOR.MINOR.PATCH` labels, which sort below every dated one. Labels are
assigned at publication; a consumer never invents one.

## Four words

| Word | Means | Address |
| --- | --- | --- |
| A release | One immutable publication | `/systems/timds-example/core/v/<label>/` |
| Current | The release the publisher points at today | `/systems/timds-example/core/` |
| `latest` | A tag for the current release that answers with the immutable address | `/systems/timds-example/core/v/latest/…` → 307 |
| Pinned | The release a product's `timds.consumer.json` names | In the product, not on the host |

Current and `latest` move together: publish moves them forward, rollback
moves them back. A rollback is a pointer operation; it restores an earlier
release byte for byte and does not rewrite history, so a product that pinned
the rolled-back label keeps working and `changelog.json` keeps the entry.

Current can therefore be older than the newest label. "Latest" on this host
means "what the publisher wants served", not "the highest number".

## Caching

| Address | Cache rule |
| --- | --- |
| Current root and the files under it | `public, max-age=300, must-revalidate` |
| `/v/<label>/` and the files under it | `public, max-age=31536000, immutable` |
| `/v/latest/…` (the redirect itself) | `public, max-age=300, must-revalidate`; `X-TimDS-Version` names the target |

Load production assets from the immutable address, by pin or through
`latest`, so a page and the assets it then loads come from one release. Loading
from the current root can tear when a publication lands between two requests.

## Reading what changed

- `changelog.json` under the root lists every release with its notes, newest
  first; the `/changelog/` page shows the same.
- `.timds-artifact.json` beside the root names the current version, source
  commit and content digest, the artifact entry and where each derived document
  sits. The same file under `/v/<label>/` is that release's stamp.
- Every document names the version it belongs to, through the stamp beside
  it. Report that version with anything you build.

## Same label, different bytes

A system imported from an earlier host can have republished one label. The
host serves the current pointer at the root and the first publication of that
label under `/v/<label>/`; the two are not interchangeable, and the derived
layer says when the immutable address does not represent the current release.
Treat an equal label as no guarantee of equal content; compare content
digests when it matters.
