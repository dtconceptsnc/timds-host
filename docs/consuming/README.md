# Consuming a published Design System

These guides are for the people and agents who build *from* a Design System
that a TimDS host publishes: a developer wiring a website or app, an agent
asked to produce an email, a deck or a flyer, a designer checking what the
system offers. Contributing to a system is a different job; start at
[contributing to Design Systems](../contributing-design-systems.md) for that.

Every example uses the synthetic system `timds-example/core` on a host whose
public origin is `https://public.example.com`. Substitute your system id and
the public origin your operator gives you.

## The CLI

Everything in these guides runs through the TimDS CLI, the npm package
[`@dtconcepts/timds`](https://www.npmjs.com/package/@dtconcepts/timds). Run it
at `@latest` so you always have the current toolkit and never maintain a
version yourself:

```sh
npx --yes @dtconcepts/timds@latest consumer --help
```

Or install it once and call `timds` directly:

```sh
npm install --global @dtconcepts/timds@latest
```

Do not pin a toolkit version in these commands or in your notes. Inside a
product repository, `timds consumer init` adds the toolkit to the product's
own dependencies so `npm run timds -- consumer …` runs the same copy for
every developer and CI job; refresh it with
`npm install --save-dev @dtconcepts/timds@latest`.

## Where a published system lives

| Address | What it is | Caching |
| --- | --- | --- |
| `https://public.example.com/systems/timds-example/core/` | The current release: browsable guide, derived documents, stamp | Five minutes, revalidated |
| `https://public.example.com/systems/timds-example/core/v/<label>/` | One release, immutable | One year |
| `https://public.example.com/systems/timds-example/core/v/latest/…` | A tag for the current release; answers 307 to the immutable address | Five minutes, revalidated |

A system id with more than two segments uses one URL-encoded segment instead,
`/systems/a%2Fb%2Fc/`. Beside the root sits `.timds-artifact.json`, the stamp
that names the version, the source commit, the artifact entry and where each
derived document is.

## Two ways to consume

1. **A product pinning a release.** `timds consumer init` pins a release and
   fetches the system's stylesheets and assets into the product at install
   time, verified by digest. See [pin and sync](pin-and-sync.md) and
   [implement styles](styles.md).
2. **Reading the published documents.** Anything that can fetch a URL, an
   agent included, reads `llms.txt`, `brand.json`, `tokens.json`,
   `index.json`, `formats.json`, `designs.json`, `changelog.json` and
   `bundle.json` under the root. See [connect an agent](connect.md); the
   documents are described in
   [published derived layer](../api/published-derived-layer.md).

## The version rule

The current release is the default everywhere, and every read resolves it
again. Read an earlier release only when someone asks for one, and say
which version you used. A product built against a pinned release may trail
the current one; that is a fact to report, not to hide.

## The guides

| Guide | Read it when |
| --- | --- |
| [connect.md](connect.md) | You are pointing an agent or a script at a system and need the documents to read and the first reads to make. |
| [styles.md](styles.md) | You are implementing a product's styles from the system, or deciding whether to include CSS at all. |
| [pin-and-sync.md](pin-and-sync.md) | You are pinning a release in a repository and want install and CI to fetch it. |
| [produce-assets.md](produce-assets.md) | You are producing something that is not a web page: an email, a deck, a social post, a print sheet, a video board. |
| [designs-and-guidance.md](designs-and-guidance.md) | You are porting a website design or need the voice, compliance and media rules. |
| [versions-and-releases.md](versions-and-releases.md) | You need to know what current, pinned, latest and a release label mean, and how rollback affects them. |
| [what-a-system-publishes.md](what-a-system-publishes.md) | A document is missing from a release and you need to tell "not yet" from "not supported". |
