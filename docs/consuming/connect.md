# Connect an agent to a published system

An agent produces on-brand work by reading the published system, never by
guessing. This guide gives the setup, the documents, and the first reads.

## In a product repository: the CLI and its skill

Run the CLI at `@latest` from the product's root:

```sh
npx --yes @dtconcepts/timds@latest consumer init \
  --system timds-example/core \
  --url https://public.example.com/systems/timds-example/core
```

Besides the pin and the install-time sync ([pin and sync](pin-and-sync.md)),
`consumer init` installs the `timds-consume-design-system` skill. The skill
tells an agent where the pinned bundle is, which published documents to read
and in what order, what it may change in the product, and how to open a
reviewable pull request. After init, `npm run timds -- consumer …` runs the
product's own copy of the CLI; `timds consumer check` and
`timds consumer notes` are the commands an agent uses most.

## Anywhere else: the published documents

A published system is a set of plain documents under its public root. They
need no sign-in and no token, and any tool that can fetch a URL can read them.
With the current root `https://public.example.com/systems/timds-example/core/`:

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

1. `llms.txt`, once per conversation. Note the version from the stamp;
   report it with everything you build.
2. For colours and fonts, the roles in `brand.json` before raw names in
   `tokens.json`. For marks and imagery, the logos and imagery in
   `brand.json`. For copy, `llms-full.txt` and the guidance groups in
   `brand.json`. For a size, `formats.json`. For a page to match,
   `designs.json`.
3. Report what you used: the version, roles and tokens, assets by name, and
   guidance pages. Name anything you could not resolve.

## When the read fails

A failed current read means the current guidance could not be verified. Say
so. Do not present an earlier result as current, and do not fall back to a
cached copy without saying it is one.

## When the system falls short

A missing token, an unfilled role, a format the catalog lacks: these are gaps
in the system, not things to invent. Tell the system's owner; the fix is made
in the system's repository and published through its review.
