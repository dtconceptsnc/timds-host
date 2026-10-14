# Port designs and follow guidance

## Website designs

A system can hold whole-page designs: each design has routes, and each route
has states (default, a sent form, an empty list, an error). They are the
reference a product route must match.

- `list_designs` lists the designs with their routes and states;
  `read_design` returns one page state as the authored HTML and JavaScript
  together with the system stylesheets, scripts and media it loads. Without
  MCP, `designs.json` under the public root lists the same.
- Port the design: rebuild the route in the product's own layouts and
  components so it matches the design's structure, composed from the system's
  classes and tokens, with the product's routing, data, metadata and
  accessibility wiring. Express every state the design shows as the product
  reaches it.
- Never copy the design's HTML file into the product as a page, and never
  restyle the design. A state the product cannot express yet is a product
  change to make or call out, not a design to simplify.
- Site-absolute references inside a design resolve under the design document's
  `base` when published, and inside the pinned checkout otherwise.

In `timds.consumer.json`, `preview.designs` pairs a product route with a
design page, `"<design>:<route>"`. `timds consumer check` verifies each
pairing against the pin, and `timds consumer preview` captures the design
beside the route at the same widths and schemes so a reviewer sees the
reference and the port side by side. A pull-request preview, when the product
enables it, shows the same pairing.

## Guidance

- `search_guidance` answers a question with the blocks that contain every
  term, guidance groups first, each cited by page and block. `read_page`
  returns a whole page as Markdown when you need the surrounding context;
  `list_pages` is the directory.
- `llms.txt` under the public root is the brand essentials and page directory
  in the llms.txt convention, and `llms-full.txt` the pages in full. Either
  works for a tool that reads a URL rather than MCP.
- Compliance guidance is binding; voice guidance shapes copy. When a request
  conflicts with either, say so.

## Media

- `list_media` returns the reviewed catalog: logical keys, titles, kinds,
  tags, stable public URLs, sizes, and measured dimensions or durations.
  Reference assets by stable URL or key.
- Logos and brand imagery are in `get_brand`, with their intended
  backgrounds. Do not draw, recolour or stretch a mark. Do not substitute
  stock, generated or third-party imagery unless guidance allows it.
- Media masters, video, audio and full-resolution photography belong in the
  system, published from its repository. A product references them; it does
  not commit copies.

## When the system falls short

A missing token, an unfilled role, a format the catalog lacks, guidance that
reads wrong: these are gaps in the system, not things to invent in the
product. Report them. With an authenticated host connection, `report_gap`
files one as a Request stamped with the version observed; identical reports
reuse their Request. Opinions about style are not gaps.
