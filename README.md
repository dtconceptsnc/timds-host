# TimDS Host

An Apache-2.0 Cloudflare host for TimDS sessions, collaboration, previews and
publication. The toolkit remains `@dtconcepts/timds` (MIT).

**Implementation in progress.** This checkout contains the versioned contract
and the proven toolchain foundation. It does not yet serve authoring traffic.
Production cutover is gated on conformance against the existing portal, then the
new host, and byte-for-byte checks of existing published systems.

The extraction is tracked in
[toperator #69](https://github.com/dtconceptsnc/toperator/issues/69).

## Toolchain

Node.js 22.18+ and npm are required. `cf` is pinned to `1.0.0-beta.14`, with a
committed npm lockfile and `cloudflare.config.ts`. No Wrangler dependency is
required. The Cloudflare Vite plugin builds the Worker and its container images.

```sh
npm ci
npm run dev
npm run typecheck
npm run build
npm run deploy
```

`cf dev` uses the local runtime; `cf dev --local` is invalid in this release.
Docker must be running for Sandbox development. Artifacts has no local emulator:
its binding requires `dev: { remote: true }` and a disposable remote namespace.
Local tests must state whether they use that namespace or an explicit test adapter.

The Phase 0 spike deployed a container-backed SQLite Durable Object, executed
Git against a disposable Artifacts repository, and exercised D1, R2 and a Queue
using `cf` alone. Reproduction details and sanitized receipts are in
[Phase 0 evidence](docs/evidence/phase-0.md).

A second [Workers Builds spike](docs/evidence/cf-preview-builds.md) proved
`cf deploy` on main and `cf previews deploy` on a review branch, including real
success events and public HTML. Both spikes' remote resources were cleaned up.
The tested beta needs an explicit preview migration on newly created Builds
connections and has no Preview-delete CLI command; the documented cleanup uses
the verified Cloudflare API. No Wrangler command was required.

## Contract

[`docs/api/timds-host.openapi.json`](docs/api/timds-host.openapi.json) is vendored
from portal commit `89b1b72`. API v1 uses `X-TimDS-API-Version: 1` and
`apiVersion: 1`. The toolkit chooses a host with `provider: { kind: 'hosted', url }`.
The contract must pass a black-box suite against the production portal before
the host's replacement domain services are implemented.

The [conformance package](conformance/README.md) pins toolkit 0.1.464 and validates
host responses against the vendored OpenAPI contract. [CI instructions](docs/ci.md)
describe the automatic foundation checks and separate manually dispatched test
of an explicitly selected disposable host. A green foundation build does not
claim live host conformance; the initial portal acceptance run is still pending.

The [architecture plan](docs/architecture.md) describes the proposed coordinator,
grant consistency, publication recovery, identity and per-system migration
protocols. It separates planned implementation from the evidence above.

## License

Apache License 2.0. See [LICENSE](LICENSE). The TimDS toolkit is a separate MIT
dependency; its license is unchanged.
