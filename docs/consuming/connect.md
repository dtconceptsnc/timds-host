# Connect an agent to a published system

An agent produces on-brand work by reading the published system, never by
guessing. This guide gives the connection, the tools, and the first calls.

## The read server over stdio (full tool set)

The toolkit serves the complete consumer tool set from a published root. It
needs no sign-in and no token. In an MCP client's configuration (Claude Code
and Cursor read `.mcp.json` at the repository root):

```json
{
  "mcpServers": {
    "timds-design-system-read": {
      "command": "npx",
      "args": ["-y", "@dtconcepts/timds@0.1.476", "mcp", "read", "--published", "https://public.example.com/systems/timds-example/core/"]
    }
  }
}
```

Pin the toolkit version you tested with. The server is named
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
| `report_gap` | Files a gap. The anonymous stdio server has no intake and says so; see below. |

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

A consumer with an account on the host connects to
`https://host.example.com/api/timds/mcp` instead, through the host's OAuth
sign-in. That connection keeps the same reads and adds `report_gap`, which
files a Request into the system's intake, stamped with the version it was
observed on. The contract is in [designer MCP](../api/designer-mcp.md).

## First calls

1. `get_consumer_guide`, once per conversation.
2. `describe_system`. Note the served version; every result names it.
3. For colours and fonts, `resolve_role` before `get_tokens`. For marks and
   imagery, `get_brand` and `list_media`. For copy, `search_guidance`. For a
   size, `list_formats`. For a page to match, `list_designs`.
4. Report what you used: the version, roles and tokens, assets by name, and
   guidance blocks by page. Name anything you could not resolve.

## When the read fails

A failed current read means the current guidance could not be verified. Say
so. Do not present an earlier result as current, and do not fall back to a
cached copy without saying it is one.
