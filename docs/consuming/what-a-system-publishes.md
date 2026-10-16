# What a system publishes, and what "not published" means

A consumer reads the documents the system's publication produced. When a
document is absent from a release, that is a fact about this release, not a
failure, and not a reason to invent the missing thing: no `formats.json`
means no format catalog, no `designs.json` means no designs, no `bundle.json`
means no consumer bundle.

| Consumer guide | Depends on | Produced from | Absent means |
| --- | --- | --- | --- |
| [connect](connect.md), [designs and guidance](designs-and-guidance.md) | `index.json`, `llms.txt`, `llms-full.txt` | The system's pages | Always present for a published system |
| [styles](styles.md) | `tokens.json` | The custom properties its stylesheets declare | Always present |
| [styles](styles.md), [produce assets](produce-assets.md) | `brand.json` roles | Conventional tokens (`--bg`, `--surface`, `--accent`, `--text`, `--muted`, `--font-display`, `--font-body`, `--font-ui`) or a `brand.roles` map in `timds.json` | Unfilled roles are listed under `missingRoles` |
| [produce assets](produce-assets.md) | `brand.json` logos and imagery | Page annotations the brand kit reads, and the system's published media | Logos and imagery come only from `brand.json` |
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
document the system does not publish asks the system's owner for it. A
consumer does not produce the document itself.

## The toolkit

The `consumer` commands come from `@dtconcepts/timds`. Run it at `@latest`
and do not pin a version: an older toolkit may not understand documents a
newer publication writes, and then reports them as absent. In a product,
`consumer init` records the toolkit as a dev dependency; refresh it with
`npm install --save-dev @dtconcepts/timds@latest`.
