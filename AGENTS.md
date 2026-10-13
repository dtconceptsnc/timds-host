# Working in this repository

This file is for coding agents and for people working alongside them. It is the
contract for any change: read it before editing, and keep it accurate when the
commands or layout change. `CLAUDE.md` imports it, and `conformance/`,
`runtime/`, `scripts/` and `studio/` carry short local supplements.

TimDS Host is an Apache-2.0 Cloudflare host for TimDS design-system sessions,
collaboration, previews, publication and Studio. The toolkit is a separate
package, `@dtconcepts/timds`. [`README.md`](README.md) is the public overview and
[`docs/README.md`](docs/README.md) indexes every document; the documents are the
specification, so a runtime change is not finished until its document agrees.

## Public repository privacy

This is a public, reusable host repository. Do not commit customer names, domains,
organization/source IDs, production source/release commits or hashes, object keys,
customer content, deployment inventories, or resumable customer work records.
Use synthetic identities and reserved example domains in documentation and fixtures.
Generic protocol terms such as OAuth client are appropriate.

Keep operational receipts and installation-specific configuration in private
operator storage outside this repository. The ignored `docs/evidence/` path must
not be force-added. PR descriptions, comments and commit messages follow the same
privacy boundary. Public documentation should explain reproducible validation;
it should not link to customer-specific operational records.

The checkout's gitignored `.env` holds the installation record and runtime
secrets. Never read it into a transcript, print its values, or copy them into
any file. `npm run check:boundary` scans the lines a branch adds for hostnames,
server paths, identifiers and credential material that look like installation
records; run it before opening a pull request.

## Repository map

| Path | What lives there |
| --- | --- |
| `src/` | The API Worker. ES modules (`.mjs`); `src/index.ts` only re-exports the Worker and Durable Object classes. |
| `src/entrypoint.mjs` | Request routing: public roots, health, Studio assets, feed upgrade, OAuth, API v1. |
| `src/api.mjs`, `src/http.mjs` | API v1 dispatch and shared headers/error helpers. |
| `src/auth/` | OAuth provider, Cloudflare Access verification, authorization facade. |
| `src/coordinator/` | `SystemCoordinator` Durable Object: per-source SQLite state, event feed, publication pointer. |
| `src/store/` | D1 catalog, SQLite collaboration store, `fail(status, message)` errors. |
| `src/domain/`, `src/requests/`, `src/live/` | Session rules, designer Requests, native live sessions. |
| `src/publication/`, `src/build/` | Seven-stage publication Workflow, release storage, build cache. |
| `src/preview/` | Frozen submission Previews on Cloudflare Workers Builds. |
| `src/public/`, `src/mcp/`, `src/media/` | Public reads, MCP servers, source media. |
| `src/imports/`, `src/invitations/`, `src/lifecycle/` | Portal imports, access invitations, source deletion. |
| `runtime/` | Container code and Dockerfiles for repository, live and build sandboxes. |
| `public-worker/` | The separate public Worker; it receives only the public-read service binding. |
| `studio/` | Static Studio client served from an allowlist; no build step. |
| `migrations/` | D1 migrations, numbered and append-only. |
| `conformance/` | Standalone API v1 conformance package with its own lockfile and tests. |
| `docs/` | Architecture, operations, API notes, recovery procedures. Index in `docs/README.md`. |
| `docs/api/timds-host.openapi.json` | The vendored API v1 contract. Additive changes only. |
| `scripts/` | Operational tools and the repository checks. Most touch real resources. |
| `test/` | `node --test` suites using real SQLite adapters; see "Which checks mean what". |
| `spikes/` | Historical proofs of tooling behaviour. Reference only; do not extend. |
| `cloudflare.config.ts` | Worker, Durable Object, container, queue and Workflow configuration driven by `TIMDS_*` environment. |

## Commands

Node.js 22.18 or newer (`.nvmrc`), npm and, for `build`, a running Docker
engine. Everything below runs from the repository root unless noted. None of
these commands need Cloudflare credentials or network access to a host.

| Command | Does | Needs |
| --- | --- | --- |
| `npm ci` | Install pinned dependencies. | network once |
| `npm run typecheck` | Generates Worker types, then `tsc --noEmit`. | nothing else |
| `npm run build` | `cf build`: bundles the Worker and builds the three container images locally. | Docker |
| `npm test` | The focused suites CI runs (file trees, build cache). Fast and green. | nothing else |
| `npm run test:all` | Every `test/**/*.test.mjs` suite. Some are known to fail; see below. | nothing else |
| `npm run check:docs` | Markdown links and anchors resolve; every `docs/` file is in `docs/README.md`. | nothing else |
| `npm run check:boundary` | Public-boundary scan of lines added since the merge base. `-- --all` audits everything. | nothing else |
| `npm run check` | typecheck, test, check:docs and check:boundary in sequence. | nothing else |
| `node --test test/<area>/*.test.mjs` | One area's suites. | nothing else |
| `cd conformance && npm ci --ignore-scripts && npm test` | Conformance harness unit tests. | network once |
| `npm run dev` | `cf dev`. Artifacts still needs a remote disposable namespace. | credentials |

Do not run `npm run deploy`, `python3 scripts/deploy-host.py`, or
`conformance` `npm run test:host` unless the person you are working with has
asked for that deployment or that fixture run in this conversation. They change
real Cloudflare resources or write to a real source.

## Which checks mean what

Local checks establish that the Worker compiles, the images build and the
in-process logic holds. They never establish that a deployed host behaves;
[`docs/ci.md`](docs/ci.md) and [`docs/verification.md`](docs/verification.md)
separate build checks from authenticated live acceptance. Do not describe a green
local run as acceptance, and do not claim a live result you did not observe.

Choose the local check by the change:

- **Documentation or examples only:** `npm run check:docs` and `npm run check:boundary`.
- **Worker or runtime code:** `npm run typecheck`, `npm run build`, the suites
  for the areas touched, and the document that specifies the behaviour.
- **`cloudflare.config.ts`, Dockerfiles, migrations:** `npm run build` plus the
  operations runbook section that describes them.
- **Conformance package:** its own `npm test`; the host tests stay untouched.

Known state of `npm run test:all` as of 2026-10-13 on Node 26: 105 pass, 23
fail. The failures are in `test/publication/steps.test.mjs`,
`test/runtime/artifacts.test.mjs`, `test/runtime/repository-adapter.test.mjs`,
`test/live/sessions.test.mjs`, `test/mcp.test.mjs`, `test/store.test.mjs` and
`test/store-workerd.test.mjs`, and they predate any current branch. Treat a
failure in those files as signal only if your change touches that area; do not
spend a task "fixing" them unless that is the task. The other eleven suites and
the focused `npm test` set pass.

## Conventions

- **Modules.** Source is ES modules in `.mjs`; TypeScript appears only in
  `src/index.ts` and the Cloudflare configuration. No transpile step for `src/`.
- **Style.** Match the surrounding file. Most modules are dense: single quotes,
  semicolons, few blank lines, no space around `=` in the compact files, and
  one-line guards such as `if(!row)throw fail(404,'...')`. Do not reformat
  code you are not changing.
- **Construction.** Modules export factories such as `createApi({...})` that
  take their collaborators as arguments. Tests inject real SQLite adapters from
  `test/sqlite-adapters.mjs` rather than mocks. Keep that shape.
- **Errors.** Fail closed. Throw `fail(statusCode, message)` from
  `src/store/errors.mjs`; messages are host-authored and safe to return, never
  provider bodies, model output or credentials.
- **Authority.** Every mutation rechecks current D1 principal, source and grant
  authority at the time it runs. Request bodies never select a source or actor.
- **API v1.** Requests carry `X-TimDS-API-Version: 1`. Contract changes are
  additive and go into `docs/api/timds-host.openapi.json` with the document
  that explains them.
- **Pins.** `cf@1.0.0-beta.14`, its Vite plugin, toolkit `0.1.464` in
  `runtime/` and `conformance/`, and `0.1.472` at the root are deliberate.
  Do not bump them as a side effect of another change.
- **Migrations.** Add a new numbered file under `migrations/`; never edit an
  applied one. Document the enabling flag and when to apply it.
- **Documents.** Keep documents descriptive of the code as it is. When you add
  a document under `docs/`, add it to `docs/README.md` in the same change.
  Write dates in full (`2026-10-13`), not relative.
- **Containers.** `runtime/` runs inside Cloudflare Containers from the
  Dockerfiles in that directory. Anything the Worker needs from a container
  goes through the RPC surfaces in `runtime/index.mjs` and `runtime/build.mjs`.

## Making a change

1. Read the document for the area before the code; the map above and
   `docs/README.md` say which one. Module READMEs in `src/preview/`,
   `src/requests/` and `studio/` are part of that specification.
2. Keep the change to the request. Preserve unrelated edits already in the
   working tree, and do not reformat, rename or "tidy" beyond the task.
3. Run the checks that match the change, as listed above, and report exactly
   what ran and what it showed. A skipped check is reported as skipped.
4. Update the specification document in the same change. Use synthetic names
   and reserved example domains (`example.com`, `timds-example`,
   `https://*.example.workers.dev`) in any example.
5. Commit with a short imperative subject line. Do not commit `.env`,
   `.env.deploy-state.json`, `docs/evidence/`, `.cloudflare/` or anything the
   boundary check flags.
6. In the pull request, say which checks ran and which did not, and whether
   deployed acceptance is still owed. `.github/PULL_REQUEST_TEMPLATE.md` lists
   the questions a reviewer will ask.

Things no task authorizes on its own: deploying, running the live conformance
harness, pointing any script at a non-disposable source, reading or printing
`.env`, force-pushing shared branches, rewriting imported sources, or pasting
installation records into issues, pull requests or commit messages.

## Where to look

| Question | Start at |
| --- | --- |
| How does a request get authenticated and routed? | `src/entrypoint.mjs`, `src/auth/`, `docs/architecture.md` "OAuth, Access and route policy" |
| What does a source coordinator persist? | `src/coordinator/`, `src/store/sqlite.mjs`, `docs/architecture.md` "SQLite schema and invariants" |
| How does publication work and recover? | `src/publication/`, `docs/architecture.md` "Publication Workflow and failure recovery", `docs/publication-queue-recovery.md` |
| How do Requests reach a model? | `src/requests/README.md`, `runtime/agent.mjs`, `runtime/live-session.mjs` |
| How are Previews deployed? | `src/preview/README.md`, `src/preview/source.mjs` |
| How is the host deployed and configured? | `docs/operations.md`, `cloudflare.config.ts`, `scripts/deploy-host.example.env` |
| What is the API contract? | `docs/api/timds-host.openapi.json`, `conformance/README.md` |
| What does Studio do and refuse to do? | `studio/README.md`, `src/studio.mjs` |
| What is public without credentials? | `src/public/`, `public-worker/src/index.ts`, `docs/migration/legacy-public-roots.md` |
