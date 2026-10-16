# Documentation index

Every document under `docs/` is listed here with the question it answers;
`npm run check:docs` fails when one is missing. Start with the row that matches
your task, then the code it names. [`AGENTS.md`](../AGENTS.md) explains how to
work in the repository and which checks apply to a change.

## Orientation

| Document | Read it when |
| --- | --- |
| [architecture.md](architecture.md) | You need the ownership model, request path, SQLite and D1 invariants, publication stages, OAuth/Access policy, public serving or Studio design. |
| [operations.md](operations.md) | You are provisioning, configuring, deploying or operating a host, or need the pinned `cf` limitations. |
| [ci.md](ci.md) | You want to know what the GitHub Actions workflows prove and how to dispatch live conformance. |
| [verification.md](verification.md) | You are deciding what counts as validation and what must stay in private operator storage. |
| [contributing-design-systems.md](contributing-design-systems.md) | You need Studio, CLI or MCP installation/connection instructions and the full contribution, review, publication and rollback lifecycle. |

## Consuming a published system

| Document | Read it when |
| --- | --- |
| [consuming/README.md](consuming/README.md) | You build from a published system: the CLI, where it lives, three ways to consume it, the version rule, and the map of these guides. |
| [consuming/connect.md](consuming/connect.md) | You are connecting an agent to a published system and need the MCP connection, the CLI setup, the documents and the first reads. |
| [consuming/styles.md](consuming/styles.md) | You are implementing a product's styles or deciding whether to include CSS at all. |
| [consuming/pin-and-sync.md](consuming/pin-and-sync.md) | You are pinning a release in a repository and want install and CI to fetch it. |
| [consuming/produce-assets.md](consuming/produce-assets.md) | You are producing an email, deck, social post, print sheet or video board from the system. |
| [consuming/designs-and-guidance.md](consuming/designs-and-guidance.md) | You are porting a website design or need the voice, compliance and media rules. |
| [consuming/versions-and-releases.md](consuming/versions-and-releases.md) | You need what current, pinned, `latest` and a release label mean, and how rollback affects them. |
| [consuming/what-a-system-publishes.md](consuming/what-a-system-publishes.md) | A document is missing from a release and you need to tell "not yet" from "not supported". |

## API and contract

| Document | Read it when |
| --- | --- |
| [api/timds-host.openapi.json](api/timds-host.openapi.json) | You change or consume an API v1 route. This vendored OpenAPI 3.1 file is the authoritative contract. |
| [api/media.md](api/media.md) | You touch source media uploads, transfer capabilities, CORS, cancellation or scoped deletion. |
| [api/provision-receipts.md](api/provision-receipts.md) | You touch the administrator read of a native provisioning receipt. |
| [api/published-derived-layer.md](api/published-derived-layer.md) | You touch the `read_derived_layer` MCP tool over immutable releases. |
| [api/designer-mcp.md](api/designer-mcp.md) | You change authenticated MCP tools or need exact authoring, check, collaboration, publication, rollback and retry contracts. |

## Features and procedures

| Document | Read it when |
| --- | --- |
| [access-invitations.md](access-invitations.md) | You touch explicit source access invitations or the `TIMDS_ACCESS_INVITATIONS_ENABLED` flag. |
| [artifacts-bindings.md](artifacts-bindings.md) | You configure the Artifacts namespace-to-binding map for dev, types, build or deploy. |
| [lifecycle-deletion.md](lifecycle-deletion.md) | You touch source archive, restore or reviewed deletion. |
| [design-system-creation.md](design-system-creation.md) | You create a native Design System in Studio, resume provisioning or change the built-in starter API. |
| [operations-designer-batch.md](operations-designer-batch.md) | You run concurrent designer Requests against a disposable system with `scripts/run-designer-batch.mjs`. |
| [publication-queue-recovery.md](publication-queue-recovery.md) | A publication is waiting or interrupted and you need the queue and recovery rules. |
| [session-start-performance.md](session-start-performance.md) | You measure start, first reads, eager live wake and bounded repository retention on an explicitly authorized disposable source. |
| [submission-recovery.md](submission-recovery.md) | A submission was interrupted and you need to resume its reservation. |
| [workers-subdomain-rename.md](workers-subdomain-rename.md) | The account's Workers subdomain changed and origins must be redeployed. |

## Migration from the portal

| Document | Read it when |
| --- | --- |
| [migration/import-protocol.md](migration/import-protocol.md) | You touch inactive portal imports, tombstone transfer or ownership activation. |
| [migration/artifact-backfill.md](migration/artifact-backfill.md) | You run or change the read-only published artifact inventory and backfill tool. |
| [migration/legacy-public-roots.md](migration/legacy-public-roots.md) | You touch the hostname-to-source compatibility for imported public roots. |
| [migration/legacy-removal-plan.md](migration/legacy-removal-plan.md) | You need the plan for removing the portal runtime after cutover. |

## Documents that live next to code

- [`../src/preview/README.md`](../src/preview/README.md): frozen submission Previews and the static Preview profile.
- [`../src/requests/README.md`](../src/requests/README.md): designer Requests, native live sessions, ordering, wake and claims.
- [`../studio/README.md`](../studio/README.md): the Studio steering console, live feed, CSP and layout.
- [`../conformance/README.md`](../conformance/README.md): the API v1 conformance harness and its disposable fixture.
- [`../spikes/`](../spikes/): historical tooling proofs, each with its own README. Reference only.

`docs/evidence/` is gitignored. Acceptance receipts and installation records
stay in private operator storage; see [verification.md](verification.md).
