# TimDS Host

An Apache-2.0 Cloudflare host for TimDS sessions, collaboration, previews,
publication and Studio. The toolkit remains `@dtconcepts/timds` (MIT).

**Implemented and deployed to an isolated host; acceptance is in progress.**
The production portal conformance baseline passed before extraction. The new
Worker, public companion, native containers, storage, OAuth discovery and Studio
assets have deployed successfully. Authenticated host conformance, existing-system
migration and production cutover remain separate gates. See the
[deployment receipt](docs/evidence/phase-3-deployment.md).

## Run your own host

Follow the [operations runbook](docs/operations.md) for resource creation,
immutable release storage, credentials, API/public deployment, Access, first
administrator bootstrap, organizations and source provisioning.
Existing portal systems use the separate [inactive import and activation
protocol](docs/migration/import-protocol.md); importing does not authorize an
automatic production cutover.

Node.js 22.18+, npm and a running local Docker engine are required. The project
pins `cf@1.0.0-beta.14` and its Cloudflare Vite plugin in the lockfile. Container
images build locally and run on Cloudflare; a VPS is not a runtime dependency.

```sh
npm ci
npm run typecheck
npm run build
```

`npm run dev` starts `cf dev`. Artifacts has no local emulator; the host's
Artifacts adapter still needs a disposable remote namespace and credentials.
Local development is not a self-contained substitute for deployed acceptance.
Deployment requires the environment and resources in the runbook.

## Runtime and contract

The API Worker owns OAuth, a D1 identity/grant catalog, per-system SQLite Durable
Objects, native repository/live/build containers, Queues and publication
Workflows. R2 holds source/build snapshots and locked immutable release objects.
A separate public Worker receives only the public-read service binding. Studio
is served from an explicit static-asset allowlist.

API v1 uses `X-TimDS-API-Version: 1` and `apiVersion: 1`; the toolkit selects the
host through `provider: { kind: 'hosted', url }`. The vendored
[OpenAPI contract](docs/api/timds-host.openapi.json),
[architecture](docs/architecture.md) and [conformance package](conformance/README.md)
describe these boundaries. The build and conformance baseline pin toolkit
`0.1.464`. Human OAuth login is available in published toolkit `0.1.471`
([merged OAuth support](https://github.com/dtconceptsnc/timds-toolkit/pull/100)).
Use `timds auth login --oauth` with the host origin; the native merge/build
container retains its validated `0.1.464` pin.

The additive source read at `GET /api/timds/design-systems/:source` returns the
authoritative published pointer, current version, at most 100 rollback versions,
and the caller's current publisher permission. It excludes provider/storage
internals and keeps the current descriptor available outside the bounded list.

## Verification and limitations

- [Production portal conformance](docs/evidence/phase-1-portal-conformance.md)
  passed the lifecycle before replacement services were implemented.
- [Native toolchain proof](docs/evidence/phase-0.md) exercised container Git,
  Artifacts, D1, R2 and Queues through `cf`.
- [Workers Builds proof](docs/evidence/cf-preview-builds.md) verified main
  `cf deploy` and branch `cf previews deploy`, success events and public HTML.
- [Runtime image proof](docs/evidence/runtime-build.md) records actual local
  image builds and an offline toolkit artifact build.
- [CI](docs/ci.md) distinguishes build checks from a manually selected live host.

No Wrangler command was required for these deployments. The pinned beta has
specific [tooling limitations](docs/operations.md#pinned-cf-limitations), including
Preview migration/readback and a direct API exception for Preview deletion.
The extraction and remaining acceptance work are tracked in
[toperator #69](https://github.com/dtconceptsnc/toperator/issues/69).

## License

Apache License 2.0. See [LICENSE](LICENSE). The TimDS toolkit is a separate MIT
dependency; its license is unchanged.
