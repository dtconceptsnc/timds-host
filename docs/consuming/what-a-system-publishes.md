# What a system publishes, and what "not published" means

A consumer tool answers from the documents the system's publication produced.
When a document is absent the tool says so: `list_formats` reports no catalog,
`list_designs` no designs, `describe_system` no bundle. That is a fact about
this release, not a failure, and not a reason to invent the missing thing.

| Consumer guide | Depends on | Produced from | Absent means |
| --- | --- | --- | --- |
| [connect](connect.md), [designs and guidance](designs-and-guidance.md) | `index.json`, `llms.txt`, `llms-full.txt` | The system's pages | Always present for a published system |
| [styles](styles.md) | `tokens.json` | The custom properties its stylesheets declare | Always present |
| [styles](styles.md), [produce assets](produce-assets.md) | `brand.json` roles | Conventional tokens (`--bg`, `--surface`, `--accent`, `--text`, `--muted`, `--font-display`, `--font-body`, `--font-ui`) or a `brand.roles` map in `timds.json` | Unfilled roles are listed as gaps |
| [produce assets](produce-assets.md) | `brand.json` logos and imagery, the media catalog | Page annotations the brand kit reads; `media.json` and published media | Logos and imagery come only from `get_brand` |
| [styles](styles.md), [pin and sync](pin-and-sync.md) | `bundle.json` and `bundle/*` | `bundle.include` globs in `timds.json` | No consumer bundle: products cannot pin; load nothing, ask the owner |
| [produce assets](produce-assets.md) | `formats.json` | `src/formats.json` in the system | No format catalog: sizes are gaps |
| [designs and guidance](designs-and-guidance.md) | `designs.json` | `src/designs/` in the system | No website designs to port |
| [versions and releases](versions-and-releases.md) | `changelog.json` | `CHANGELOG.md` | Release notes unavailable |
| every guide | `.timds-artifact.json` | Written at publication | Always present; names `entry` and `files` |

The stamp's `files` map says where each document sits for this release, and
`index.json` says which optional documents this release offers, so a reader
never picks up a document left on the CDN by an earlier release.

## Telling the owner

Everything in the middle column is a change in the system's repository, made
by its designers and published through their review. A consumer who needs a
document the system does not publish asks for it: through `report_gap` on an
authenticated host connection, or directly. A consumer does not produce the
document itself.

## Versions of the toolkit

The read server and `consumer` commands come from `@dtconcepts/timds`. Pin a
`0.1.x` release in the product's root `package.json` and in any `.mcp.json`
entry, and move it deliberately. Older toolkit releases may not understand
documents a newer publication writes; the tool then reports the document as
absent.
