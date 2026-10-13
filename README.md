# TimDS Host

An Apache-2.0 Cloudflare host for TimDS sessions, collaboration, previews,
publication and Studio. The Apache-2.0 toolkit is maintained separately as
`@dtconcepts/timds`.

**Production ownership transfer and legacy Cloudflare/portal VPS runtime retirement are complete.**
Pierce, WPL and Speed now run on the native host; Nacho remains deleted. All 14
public domains route to the new companion Worker, and the original 77 public
comparisons still match after retirement. See the
[production cutover and final retirement evidence](docs/evidence/production-cutover-2026-10-13.md#final-retirement-outcome--174107789z).

Scoped follow-ups remain for source `provider.url` configuration, specific
MCP/CIMD client acceptance, and the old shared VM/DNS inventory limits described
below. No additional UI coverage is claimed by the cutover receipts.

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

- [Production cutover and retirement](docs/evidence/production-cutover-2026-10-13.md)
  record all three ownership transfers, deleted-source retention, media hashes,
  public byte parity and removal of the legacy Cloudflare/portal VPS runtime.
- [Original N10 recovery](docs/evidence/n10-recovery.md) records all ten original
  publications completing consecutively with their identities preserved.
- [Manual publication and rollback](docs/evidence/manual-recovery-publication.md)
  record the original submission completing, rollback and restoration; the
  [media receipt](docs/evidence/native-media-acceptance.md) covers native uploads.
- [MCP acceptance boundaries](docs/evidence/mcp-acceptance-boundary-2026-10-13.md)
  distinguish authenticated reads and CLI use from unexercised fresh CIMD,
  local editing MCP authoring and remote `report_gap` write/replay flows.
- The old shared VM's local runner inventory remains unverified after an SSH
  timeout. The existing credential could not read the old runner DNS record
  (HTTP 403); no unidentified record was deleted. The tunnel and Access app are
  confirmed absent. Current source manifests still need the documented native
  `provider.url` change/new release; explicit host overrides support fresh CLI
  sessions in the meantime.
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
The completed production cutover and scoped follow-ups are tracked in
[toperator #69](https://github.com/dtconceptsnc/toperator/issues/69).

## License

Original host code is licensed under the Apache License 2.0. See
[LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party dependencies retain their
respective licenses. The toolkit source and the published
[`@dtconcepts/timds@0.1.472`](https://www.npmjs.com/package/@dtconcepts/timds/v/0.1.472)
package are Apache-2.0; that package's version/license were verified from npm.
