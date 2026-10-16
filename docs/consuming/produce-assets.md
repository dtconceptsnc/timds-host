# Produce assets from a published system

Not everything made from a system is a web page. An email, a slide deck, a
social post, a letterhead, a conference banner, a video board: each takes
values from the system and builds in its own tool. This guide is the recipe,
whatever the output. Every document named here sits under the system's
public root; [connect an agent](connect.md) lists them.

## 1. Find the format

`formats.json` is the catalog of every print sheet and screen canvas the
system produces. Each entry carries an id and name, a group (`print`,
`digital`, `social`, or the system's own), width and height with a unit
(inches for print, pixels for screens), bleed and safe margin, stock or file
notes, and the page that shows it. Filter by `group` when the catalog is long.

Produce to the catalog's numbers. A size the catalog lacks is a gap, not a
guess: say so, and tell the system's owner. If the system publishes no
catalog at all, `formats.json` is absent; see
[what a system publishes](what-a-system-publishes.md).

## 2. Resolve the brand

- The roles in `brand.json` for every colour and font decision:
  `color.background`, `color.panel`, `color.accent`, `color.text`,
  `color.muted`, `font.display`, `font.body`, `font.ui`, and any role the
  system defines. Each names its `token` and its `value`; use the `value`
  (the resolved literal) in tools that cannot load CSS.
- `tokens.json` when you need the wider palette or a spacing scale; prefer
  the base declarations for the document-level values.
- The logos in `brand.json` for marks: each has a role, a variant, the
  background it is meant for (`on`), its format and a stable URL. Take the
  primary logo unless the context calls for a variant. Never redraw,
  recolour or stretch a mark.
- Fonts come from `brand.json` too: self-hosted files by weight and style, a
  font service stylesheet, or a specimen page to obtain the family by hand.

## 3. Pick the imagery

The imagery in `brand.json`, and the assets `index.json` joins to each page,
carry stable public URLs. Reference assets by that URL or their key; never an
expiring or private one. Stock, generated or third-party imagery is off-brand
unless the system's guidance allows it.

## 4. Write the words

`llms-full.txt` holds every page's Markdown, and the guidance groups in
`brand.json` point at the pages and blocks for `voice` and `compliance`;
read those first for "how do we refer to clients" or "what may we not
claim". Compliance guidance is binding. When the copy you are asked to
produce conflicts with it, say so instead of complying silently.

## 5. Build in the right medium

| Output | Build with | Styles | Values |
| --- | --- | --- | --- |
| Print sheet, PDF | HTML rendered to PDF, or a layout tool | The system's print stylesheet if it publishes one; `@page { size: <width> <height> }` from the format, bleed added | Roles, logo files for the background, format margins |
| Social or display canvas | An image or canvas tool at the format's pixels | A canvas stylesheet if published; otherwise none | Resolved literals, media URLs |
| Email | The email tool's own templates | None external; inline literals | Role values from `brand.json`, email-safe logo files |
| Deck or slides | The deck tool | None | Resolved literals, font families, logo files |
| Video board | The system's video contract when it has one | None | Roles and the board kinds the system's guidance lists |
| A standalone HTML page | HTML | The `versioned` bundle stylesheets, or the token sheet inlined | Token names |

## 6. Report

Say which version you read, which roles and tokens you used, which assets by
name, and which guidance pages. Name every value you could not resolve. The
output is only on-brand if someone can check it against the system.
