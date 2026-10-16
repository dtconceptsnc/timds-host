# Port designs and follow guidance

## Website designs

A system can hold whole-page designs: each design has routes, and each route
has states (default, a sent form, an empty list, an error). They are the
reference a product route must match.

- `designs.json` under the public root lists the designs with their routes
  and states, and gives each page state as the authored HTML and JavaScript
  together with the system stylesheets, scripts and media it loads. In a
  pinned product the same designs sit in the synced bundle when the system
  includes them.
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

- `llms.txt` under the public root is the brand essentials and page directory
  in the llms.txt convention, and `llms-full.txt` the pages in full. Read the
  full file when you need the surrounding context of a rule; `index.json` is
  the same directory as structured blocks.
- The guidance groups in `brand.json` name the pages and blocks that hold
  `voice` and `compliance`. Start there for a question about copy; cite the
  page you relied on.
- Compliance guidance is binding; voice guidance shapes copy. When a request
  conflicts with either, say so.

## Media

- Logos and brand imagery are in `brand.json`, each with its intended
  background, format and stable public URL; `index.json` joins each page's
  assets to the media they reference. Reference assets by stable URL or key.
- Do not draw, recolour or stretch a mark. Do not substitute stock, generated
  or third-party imagery unless guidance allows it.
- Media masters, video, audio and full-resolution photography belong in the
  system, published from its repository. A product references them; it does
  not commit copies.

## When the system falls short

A missing token, an unfilled role, a format the catalog lacks, guidance that
reads wrong: these are gaps in the system, not things to invent in the
product. Tell the system's owner; the fix is made in the system's repository
and published through its review. Opinions about style are not gaps.
