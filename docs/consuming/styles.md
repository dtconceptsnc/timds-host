# Implement styles from a published system

The system owns colours, type, spacing, components and their behaviour across
schemes and widths. The product owns its layout, its routing and a thin skin
that composes what the system provides. This guide says what to load, what to
reference, and what never to copy.

## What the bundle gives you

A system that declares `bundle.include` publishes a consumer bundle: the
stylesheets, scripts and small assets a product loads, each under the same
path it has in the system's source tree. The manifest, `bundle.json`, lists
every file with its byte count and SHA-256, and gives three places to load
from:

| Field | Points at | Use it for |
| --- | --- | --- |
| `versioned` | The immutable copy of this release | Production. A release can never change under you. |
| `latest` | The tag for the current release; redirects to the immutable copy | Internal tools and previews that should follow releases. |
| `directory` | The current root's copy, which moves silently when the pointer moves | Nothing in production. |

A product that pins through `timds consumer sync` does not load from URLs at
all: the files arrive in `design-system/` at install time and the product
imports them like its own. See [pin and sync](pin-and-sync.md).

## Load order

1. The system's token or base stylesheet. It declares the custom properties
   and the scheme scopes (a dark-theme selector, for example). Without it
   nothing else resolves.
2. The system's stylesheet family for the surface you are building. A system
   typically documents a marketing family, an application or utility family,
   and specialised families for print, decks or social canvases. `describe_system`
   and the system's own guidance say which family belongs to which surface.
3. The product's skin stylesheet, which may only reference tokens and compose
   the system's classes. Product-specific layout lives here.

Load each system file from the pinned copy; never paste its contents into a
product stylesheet.

## Reference, never restate

- In product CSS write `var(--accent)`, never `#c2a15a`. The token's resolved
  literal is for places that cannot load CSS (see the table below).
- Ask by role first: `resolve_role` answers "the accent colour" and "the
  heading font" with the token that fills the role. Guessing from token names
  is how a product drifts.
- Do not redeclare a system token to change it. A different value is a
  system change, made in the system's repository.
- Scheme and width behaviour comes with the system's stylesheets. Keep light
  and dark, desktop and phone, focus states and reduced motion working in the
  product; do not override them away.
- Fonts: each font role in `get_brand` names its family and where it comes
  from. `files` are `@font-face` files the bundle carries; `stylesheets` is a
  font service the pages load; `specimen` is a page to obtain the family by
  hand; `system` means the device's fonts are intended.

## When to include CSS at all

| You are producing | Load | Take values from |
| --- | --- | --- |
| A website or app on the system | The pinned bundle's token sheet plus the family for that surface, then the product's skin | Token names, `var(--…)` |
| A single HTML artifact (landing page, report, email preview) | The `versioned` stylesheet URLs from `bundle.json`, or the token sheet inlined when the artifact must be self-contained | Token names |
| HTML email | No external CSS. Inline resolved literals. | `get_tokens` `resolved`, `resolve_role` |
| A print sheet or PDF | The system's print stylesheet if it publishes one, with `@page` sized from `list_formats` | Format numbers, roles, logo files by intended background |
| A social or display canvas | Usually none; a canvas stylesheet when the system publishes one | Format pixels, roles, media URLs |
| Figma, Canva, slides, video boards | None | Resolved literals and font families from `get_brand` |

[Produce assets](produce-assets.md) covers the rows that are not web pages.

## Verify

- `timds consumer check --require-token=--focus-ring`, one flag per custom
  property the product depends on, confirms each is defined, non-empty and
  resolvable in the synced bundle.
- Open the product and look: every review route at desktop and phone width,
  light and dark, with keyboard focus and contrast checked. A token check does
  not see the cascade.
- A token, component or role the product needs and the system lacks is a gap.
  Say so and file it with `report_gap` when the user agrees; do not add a
  product-side literal to paper over it.
