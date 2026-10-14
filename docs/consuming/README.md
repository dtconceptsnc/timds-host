# Consuming a published Design System

These guides are for the people and agents who build *from* a Design System
that a TimDS host publishes: a developer wiring a website or app, an agent
asked to produce an email, a deck or a flyer, a designer checking what the
system offers. Contributing to a system is a different job; start at
[contributing to Design Systems](../contributing-design-systems.md) for that.

Every example uses the synthetic system `timds-example/core` on a host whose
public origin is `https://public.example.com`. Substitute your system id and
the public origin your operator gives you.

## Where a published system lives

| Address | What it is | Caching |
| --- | --- | --- |
| `https://public.example.com/systems/timds-example/core/` | The current release: browsable guide, derived documents, stamp | Five minutes, revalidated |
| `https://public.example.com/systems/timds-example/core/v/2026.10.14-1/` | One release, immutable | One year |
| `https://public.example.com/systems/timds-example/core/v/latest/…` | A tag for the current release; answers 307 to the immutable address | Five minutes, revalidated |
| `https://public.example.com/mcp` | Anonymous read MCP over HTTP, `systemId` as a tool argument | none |

A system id with more than two segments uses one URL-encoded segment instead,
`/systems/a%2Fb%2Fc/`. Beside the root sits `.timds-artifact.json`, the stamp
that names the version, the source commit, the artifact entry and where each
derived document is.

## Three ways to consume

1. **An agent reading through MCP.** The toolkit's read server gives an agent
   the whole consumer tool set (brand roles, tokens, guidance, formats, designs,
   media) from the published files. See [connect an agent](connect.md).
2. **A product pinning a release.** `timds consumer init` pins a version and
   fetches the system's stylesheets and assets into the product at install
   time, verified by digest. See [pin and sync](pin-and-sync.md) and
   [implement styles](styles.md).
3. **Plain files.** Anything that can fetch a URL can read `tokens.json`,
   `brand.json`, `index.json`, `llms.txt`, `formats.json`, `designs.json`,
   `changelog.json` and `bundle.json` under the root. The documents are
   described in [published derived layer](../api/published-derived-layer.md).

## The version rule

The current release is the default everywhere, and every read resolves it
again. Pass a version only when someone asks for an earlier release, and say
which version you used. A product built against a pinned version may trail
the current release; that is a fact to report, not to hide.

## The guides

| Guide | Read it when |
| --- | --- |
| [connect.md](connect.md) | You are connecting an agent to a system and need the tools, resources and first calls. |
| [styles.md](styles.md) | You are implementing a product's styles from the system, or deciding whether to include CSS at all. |
| [pin-and-sync.md](pin-and-sync.md) | You are pinning a release in a repository and want install and CI to fetch it. |
| [produce-assets.md](produce-assets.md) | You are producing something that is not a web page: an email, a deck, a social post, a print sheet, a video board. |
| [designs-and-guidance.md](designs-and-guidance.md) | You are porting a website design or need the voice, compliance and media rules. |
| [versions-and-releases.md](versions-and-releases.md) | You need to know what current, pinned, latest and a release label mean, and how rollback affects them. |
| [what-a-system-publishes.md](what-a-system-publishes.md) | A tool says a document is not published and you need to tell "not yet" from "not supported". |
