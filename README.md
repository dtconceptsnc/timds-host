# TimDS Host

An Apache-2.0 Cloudflare host for TimDS sessions, collaboration, previews,
publication and Studio. The Apache-2.0 toolkit is maintained separately as
`@dtconcepts/timds`.

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
`0.1.464`. Human OAuth login and resumable commands are available in the validated published
toolkit `0.1.472` ([released support](https://github.com/dtconceptsnc/timds-toolkit/pull/104)).
Use `timds auth login --oauth` with the host origin; the native merge/build
container retains its validated `0.1.464` pin.

The additive source read at `GET /api/timds/design-systems/:source` returns the
authoritative published pointer, current version, at most 100 rollback versions,
and the caller's current publisher permission. It excludes provider/storage
internals and keeps the current descriptor available outside the bounded list.

## Verification and limitations

Run `npm run typecheck` and `npm run build` for local validation. The
[CI guide](docs/ci.md) distinguishes build checks from authenticated live-host
acceptance. The [conformance package](conformance/README.md) describes the API
checks and disposable resources required to run them.

Snapshot persistence and isolated build/metadata copies stream at most four
files concurrently, draining pending transfers before cleanup and committing
manifests only after all transfers succeed. Git operations and publication gates
remain serialized. Focused checks run with:

```sh
node --test test/runtime/file-trees.test.mjs test/build/cache.test.mjs
```

Keep installation inventories, customer identities, domains, source and release
IDs, operational receipts, and resumable production work records in private
operator storage. Public examples must use synthetic names and reserved example
domains. See [verification guidance](docs/verification.md).

The pinned CF beta has specific [tooling limitations](docs/operations.md#pinned-cf-limitations),
including preview migration/readback and a direct API exception for deletion.

## License

Original host code is licensed under the Apache License 2.0. See
[LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party dependencies retain their
respective licenses. The toolkit source and the published
[`@dtconcepts/timds@0.1.472`](https://www.npmjs.com/package/@dtconcepts/timds/v/0.1.472)
package are Apache-2.0; that package's version/license were verified from npm.
