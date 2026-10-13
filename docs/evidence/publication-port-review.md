# Publication and repository extraction review

This is a source inspection for issue #69, not evidence that the host domain
implementation or production conformance has passed. Read against the latest
master extraction-prep implementation on October 12, 2026.

## Publication boundary

`server/design-system-publication-steps.mjs` exports
`createDesignSystemPublicationSteps()` and six serializable step contracts:
`preflight`, `merge`, `build`, `prepare`, `release`, `close`. Its dependencies are
already injectable:

| Dependency | Required methods or behavior |
| --- | --- |
| store | `publication`, `getSource`, `getSubmission`, `checkpointPublication` |
| repository | `preparePublication`, `commitSource`, `releaseCheckout`, `pushMain`, `pushPublished` |
| artifacts | `get(ref)`, immutable `put(ref,value)` |
| toolkit | `prepareMergeRelease`, `createPublicationStampFromFiles`, `publishReleaseFromFiles` |
| build | Credential-free build from base64 source files; returns artifact file bytes |
| publish | Validate artifact identity/media, save immutable release and promote pointer |
| authorize | Recheck current publisher grant for the stored actor |
| closePublishedSession | Close session and all its owned remote resources |
| lease/view/now | Execution fencing, external publication view, deterministic clock |

`Buffer` usage can run with `nodejs_compat`. Its direct URL helper dependency
`server/design-system-public-urls.mjs` hardcodes timds.com/speed.style and existing
slug mappings; the host needs an injected public URL builder while preserving
legacy identities during cutover.

The current `release` step pushes main, pushes published artifacts, and calls
`publishReleaseFromFiles` with a publisher callback that also promotes the pointer.
Issue #69 requires a separate Workflow `flip` step, so merely wrapping the six
current functions in `step.do()` does not implement the requested seven stages.
Preserve immutable `sourceRef`/`artifactRef`, deterministic releasePreparedAt,
submission/source identity checks, retry receipts, and reauthorization at flip.
The same-day retry and queue fencing behavior have dedicated portal tests.

The current `releasePublicationVersion` Supabase RPC joins pointer movement,
current grant validation, publication checkpoint, and audit in one transaction.
A DO SQLite store and D1 cannot share that transaction. The host needs an explicit
canonical pointer and an idempotent durable outbox for D1 audit reconciliation,
including interruption/replay tests. A sequence of unrelated DO and D1 writes
must not be represented as one atomic commit.

## Build and toolkit boundary

`server/design-system-submission-publish-worker.mjs` is a Node/VPS adapter and
cannot be moved into the Worker unchanged. It uses fs, OS temp directories,
subprocesses, and Docker. `loadPublicationToolkit()` resolves an operator-owned
`@dtconcepts/timds@0.1.464` installation and imports core, publish, and the starter's
`prepare-merge-release.mjs`. These need a supported Worker-safe toolkit export or
image-baked trusted RPC implementation; source-owned toolkit files are untrusted.

Current build sequence:

1. Validate every source path and constrain symlinks to the workspace.
2. Run `npm ci --ignore-scripts` with network enabled in isolation.
3. Run the image-controlled `checkWorkspace()` with network disabled.
4. Collect only regular output files: max 12 MB per file, 80 MB total, 2,000 files.

The host's build Sandbox must retain those trust boundaries, expose the failed
check name, and implement the issue's R2 lockfile-keyed dependency snapshots. The
existing build adapter does not provide snapshots. `createPublicationArtifactStore`
is a filesystem write-once JSON staging adapter and should be replaced by R2 while
retaining its opaque-reference identity checks. Legacy import remains a migration
concern, not a filesystem dependency for the host.

## Repository boundary

`cloudflare/timds-designer/Repository.Dockerfile` image-bakes Git and the exact
0.1.464 toolkit. `repository-engine.mjs` imports `mergeFileTrees` from
`@dtconcepts/timds/merge`; it belongs inside the trusted container because it uses
Git subprocesses and fs. `repository-daemon.mjs` exposes JSON POST `/rpc` on 8081
and never runs source scripts, builds, npm, or a model.

Keep this RPC surface:

- Provision/read/remove source; start/snapshot/stale/submit/update/history/close.
- Merge into draft; merge a submission.
- `preparePublication`, `commitSource`, `pushMain`, `stagePublished`,
  `pushPublished`, `releaseCheckout`.

`server/design-system-repository-rpc.mjs` brokers each operation through
`repository-control` phases prepare/complete/release. The broker re-reads stored
source/session/submission identity, validates lifecycle leases, creates forks,
issues five-minute per-repository capabilities, and revokes them afterward. The
host can preserve its pure authorization plan while replacing Supabase and HTTP
callbacks with coordinator storage/RPC. It must not trust repository names or
submission identity supplied by callers.

`RepositorySandboxRuntime` already serializes operations, reserves opaque
publication checkout identities, strips credentials before calling the daemon,
injects them only through exact Git protocol outbound requests, and cleans up via
a 20-minute alarm. Snapshot responses stream instead of buffering 50 MB JSON in
the Worker's 128 MB heap. `pushPublished` sends 8 MB base64 fragments to stay below
32 MB native RPC limits. Preserve these limits and streaming semantics in the port.

`callback.mjs` already uses `env.TIMDS_HOST_ORIGIN || env.PORTAL_ORIGIN`, with
runner-token authentication and redirect refusal. The callback-origin extraction
prerequisite is present on this baseline. Existing live session and repository
runtime code can receive an injected callback function; it need not acquire a
new transport protocol.
