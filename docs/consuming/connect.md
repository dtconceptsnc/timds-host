# Connect an agent to a published system

An agent produces on-brand work by reading the published system, never by
guessing. This guide gives the connections, the documents, and the first
reads. Everything here is read-only and needs no sign-in and no token.

## The CLI's read server over stdio (full tool set)

The CLI serves the complete consumer tool set from a published root. In an
MCP client's configuration (Claude Code and Cursor read `.mcp.json` at the
repository root):

```json
{
  "mcpServers": {
    "timds-design-system-read": {
      "command": "npx",
      "args": ["-y", "@dtconcepts/timds@latest", "mcp", "read", "--published", "https://public.example.com/systems/timds-example/core/"]
    }
  }
}
```

Keep it at `@latest`; do not pin a toolkit version. The server is named
`timds-design-system-read` and is read-only.

| Tool | Answers |
| --- | --- |
| `get_consumer_guide` | How to use the system through these tools. Read it first. |
| `list_design_systems`, `describe_system` | What is in scope; the served and published versions, page directory, token and role counts, brand kit summary, format catalog, bundle, designs, release history. |
| `resolve_role` | A brand role (`color.accent`, `font.display`, …) to the token that fills it and its value. An unfilled role is reported as a gap, never a guessed value. |
| `get_tokens` | Resolved CSS custom properties by name, kind, scope, or base declarations only. |
| `get_brand` | Roles with their tokens, fonts with their files or service, logos and imagery with intended backgrounds and stable URLs, guidance groups. |
| `list_formats` | The asset format catalog: every print sheet and screen canvas with size, bleed, safe margin and notes. |
| `list_pages`, `read_page` | The page directory and one page or block as Markdown or structured blocks. |
| `search_guidance` | The blocks that answer a question, guidance groups (voice, compliance) first, each cited by page and block. |
| `list_designs`, `read_design` | The website designs the system holds, and one page state as authored HTML. |
| `list_media` | The published media catalog by tag or kind, with stable URLs. |

Resources mirror the documents: `timds://consumer-guide`, `timds://brand.json`,
`timds://tokens.json`, `timds://index.json`, `timds://llms.txt`,
`timds://formats.json`, `timds://bundle.json`, `timds://guidance/{group}`.

Every tool takes an optional `version`. Omit it, or pass `latest`, for the
current release.

## The host's read MCP over HTTP (published reads)

The public origin answers MCP at `/mcp` without authentication. It carries the
published read tools `describe_system`, `get_tokens`, `read_page` and
`read_derived_layer`, each taking `systemId` and an optional `version`
(`latest` means current). `read_derived_layer` returns every derived document
with an exact source and version receipt in one call.

```json
{
  "mcpServers": {
    "timds-host-read": { "type": "http", "url": "https://public.example.com/mcp" }
  }
}
```

## In a product repository: the CLI and its skill

Run the CLI at `@latest` from the product's root:

```sh
npx --yes @dtconcepts/timds@latest consumer init \
  --system timds-example/core \
  --url https://public.example.com/systems/timds-example/core
```

Besides the pin and the install-time sync ([pin and sync](pin-and-sync.md)),
`consumer init` installs the `timds-consume-design-system` skill, which tells
an agent where the pinned bundle is, which published documents to read and in
what order, what it may change in the product, and how to open a reviewable
pull request. It also writes an `.mcp.json` entry; point that entry at the
stdio read server above. After init, `npm run timds -- consumer …` runs the
product's own copy of the CLI; `timds consumer check` and
`timds consumer notes` are the commands an agent uses most.

## The published documents

A published system is also a set of plain documents under its public root,
which any tool that can fetch a URL can read. The MCP tools above answer from
these same files. With the current root
`https://public.example.com/systems/timds-example/core/`:

| Document | Answers |
| --- | --- |
| `llms.txt` | The brand essentials and the page directory, in the llms.txt convention. Read it first. |
| `llms-full.txt` | Every page's Markdown in one file: guidance, voice, compliance, component usage. |
| `index.json` | The page directory as structured blocks, with each page's assets joined to the media they reference. |
| `brand.json` | Brand roles (`color.accent`, `font.display`, …) with the token that fills each and its resolved value, fonts with their files or service, logos and imagery with intended backgrounds and stable URLs, guidance groups. An unfilled role is listed under `missingRoles`, never guessed. |
| `tokens.json` | Every CSS custom property the pages load, resolved by scope, with the roles it fills. |
| `formats.json` | The asset format catalog: every print sheet and screen canvas with size, bleed, safe margin and notes. |
| `designs.json` | The website designs the system holds: every route and state as authored HTML on the system's stylesheets. |
| `changelog.json` | Every release with its notes, newest first. |
| `bundle.json` | The stylesheets, scripts and assets a website loads, with digests and the immutable copy to pin. |
| `.timds-artifact.json` | The stamp: version, source commit, entry, and where each document sits. |

The same documents sit under `/v/<label>/` for one immutable release. Omit
the label, or use `/v/latest/`, for the current release. The documents a
release may lack, and what that means, are in
[what a system publishes](what-a-system-publishes.md).

## First reads

1. `get_consumer_guide` over MCP, or `llms.txt` by URL, once per
   conversation. Then `describe_system`, or the stamp: note the version and
   report it with everything you build.
2. For colours and fonts, `resolve_role` or the roles in `brand.json` before
   raw names in `tokens.json`. For marks and imagery, `get_brand` and
   `list_media`, or the logos and imagery in `brand.json`. For copy,
   `search_guidance`, or `llms-full.txt` and the guidance groups in
   `brand.json`. For a size, `list_formats` or `formats.json`. For a page to
   match, `list_designs` or `designs.json`.
3. Report what you used: the version, roles and tokens, assets by name, and
   guidance blocks by page. Name anything you could not resolve.

## When the read fails

A failed current read means the current guidance could not be verified. Say
so. Do not present an earlier result as current, and do not fall back to a
cached copy without saying it is one.

## When the system falls short

A missing token, an unfilled role, a format the catalog lacks: these are gaps
in the system, not things to invent. Tell the system's owner; the fix is made
in the system's repository and published through its review.
