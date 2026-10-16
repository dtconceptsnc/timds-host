# Pin a release in a product repository

A product (a website, an app) pins one release of the system and fetches that
release's bundle at install time. No system bytes are committed; a clone and
`npm ci` is all a developer, a CI job or an agent needs.

## Initialise

From the product repository root:

```sh
npx --yes @dtconcepts/timds@latest consumer init \
  --system timds-example/core \
  --url https://public.example.com/systems/timds-example/core
```

`--url` is the system's public root without a trailing slash. Without it the
toolkit assumes a different host layout and sync fails with `fetch failed`.
Without `--version` the pin is the label of the release that is current at
that moment, read from the root; pass `--version current` to follow every
release instead. Studio's Deliverables view offers this command filled in
when the release has an immutable address and a bundle it can name.

`consumer init` writes and manages:

- `timds.consumer.json`: the pin, each app, how to run it, the routes to
  review, and the paths a designer change may touch.
- In `package.json`, the toolkit as a dev dependency, a `timds` script, and a
  `postinstall` that runs `timds consumer sync`; plus a `.gitignore` entry for
  `design-system/`. From then on `npm run timds -- consumer …` runs the
  product's own copy of the CLI, which is what the commands below mean by
  `timds`.
- The `timds-consume-design-system` skill, the preview and designer-change
  workflows, and `.claude/launch.json` entries.

Managed files are tracked by digest; your own edits are kept unless you pass
`--force`.

## The pin

```json
"designSystem": {
  "path": "design-system",
  "systemId": "timds-example/core",
  "version": "<release label>",
  "url": "https://public.example.com/systems/timds-example/core"
}
```

- A **release label** pins one release; `consumer init` fills in the one it
  resolved. Moving it is an explicit developer decision, made with
  `timds consumer update <label>` or by hand, and reviewed like any dependency
  bump.
- `"current"` follows every release at the next install. Use it for internal
  tools, not for a production site that reviewers sign off on.
- A **git submodule** at `design-system/` is the older form. `timds consumer
  migrate` moves a product to a published pin in one reviewable change.

## What sync does

`timds consumer sync` reads `<url>/v/<version>/bundle.json`, verifies the
manifest is stamped with that version, downloads every listed file into
`design-system/` under the same path it has in the system tree, checks each
SHA-256, removes files the previous sync wrote that the release no longer
lists, and records the result in `design-system/.timds-bundle.json`. The host
serves that manifest at the system root even when the system keeps it beside
a nested entry, so the URL above is always right.

The product then imports the files as its own:

```css
@import "../design-system/src/styles/tokens.css";
@import "../design-system/src/styles/site.css";
```

Paths are whatever the system's `bundle.json` lists; the system's `llms.txt`
and guidance say which stylesheet belongs to which surface.

## In CI

Because the root package and lockfile are what fetches the bundle, CI needs
only its normal install step. A failing sync fails the install, early and
loudly:

| Message | Meaning | Fix |
| --- | --- | --- |
| `fetch failed` | The `url` points at a host that does not exist or does not serve this layout. | Set `url` to the system's public root on the current host. |
| `…bundle is not published at <url>/v/<version>/bundle.json` | That release has no bundle, or the version label is wrong. | Check the label against `changelog.json`; a system without `bundle.include` publishes no bundle at all. |
| `…bundle is stamped <other version>` | The manifest at that address belongs to another release. | Report it to the system's operator; do not pin the other version blindly. |
| A SHA-256 mismatch | A downloaded file differs from the manifest. | Retry once; if it persists the release is damaged and the operator needs to know. |

Keep the toolkit current with `npm install --save-dev @dtconcepts/timds@latest`;
`consumer check` warns when the lockfile's toolkit predates published pins.

## Check, update, preview

- `timds consumer check` validates the manifest and the pin, confirms the
  synced bundle is at the pinned version, and with `--base origin/main`
  fails on any change outside a declared design surface or any move of the
  pin. `--require-token=--name` checks a custom property the product needs.
- `timds consumer update [LABEL]` moves the pin and syncs; without a label it
  moves to the current release. Read `changelog.json` between the old and new
  labels first; the `timds-update-design-system` skill walks an agent through
  porting what changed.
- `timds consumer preview --app NAME` builds or serves an app and writes a
  review folder with captures per route, width and scheme, paired with the
  system's designs where `timds.consumer.json` declares a pairing.

## Working on both repositories

A developer with the system checked out beside the product can symlink
`design-system/` to that checkout. `sync` leaves a symbolic link alone and
`consumer check` warns that the local working copy replaces the published
pin. Do not commit the link.
