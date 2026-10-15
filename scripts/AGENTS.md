# scripts/ for agents

Supplements the root [`AGENTS.md`](../AGENTS.md).

Safe to run at any time, read-only, no credentials:

- `check-docs.mjs`: Markdown links, anchors and the `docs/README.md` index.
- `check-public-boundary.mjs`: scans added lines (or `--all`) for
  installation and customer records. Both are wired to `npm run check:*`.

`generate-design-system-starter.mjs` reproduces the built-in standalone starter
in disposable local directories using its checked-in npm lockfile, compares
every source file, runs the toolkit build/check and verifies byte-identical cf
packaging. It needs registry access and writes no cloud resources. `--write`
replaces the generated starter bundle after those checks; keep existing starter
revisions immutable once deployed so creation retries retain their exact bytes.

Operational tools; each acts on real resources and needs a person's explicit
request for a specific target in the current conversation:

- `deploy-host.py`: deploys the API and public Workers from the checkout's
  gitignored `.env`. Never print or copy that file.
- `admin.mjs`: host administration against a deployed origin (`--help`).
- `access-plan.mjs`: produces reviewable Access configuration; writes nothing.
- `run-designer-batch.mjs`: creates real Requests and can publish; incurs
  model charges. Disposable systems only (`../docs/operations-designer-batch.md`).
- `profile-session-start.mjs`: opt-in Node `--import` timing preload for the
  installed toolkit CLI. The preload sends no requests itself, but the profiled
  `timds start` and `pull` commands act on a real source and local destination;
  obtain explicit fixture authorization first. Timing output contains only
  fixed labels, times, status and attempt counts. See `../docs/operations.md`.
- `backfill-published-artifacts.mjs`: defaults to a read-only inventory;
  `--help` describes the write modes (`../docs/migration/artifact-backfill.md`).
- `prepare-preview-source.mjs`: defaults to a plan; `--apply` installs pins
  and builds (`../src/preview/README.md`).

The root `.env.example` lists every installation and secret key; copy it to
`.env`, which stays outside version control. New `TIMDS_*` text bindings in
`cloudflare.config.ts` must also be added to the example file and to the
environment the deploy helper builds, or they deploy empty.
