# Foundation and host conformance CI

The workflows test different things. A green **Foundation checks** run means
the current Worker typechecks/builds, the plain-Node smoke suite passes, and
the conformance harness passes its own unit tests. The native host is implemented and deployed to an isolated account
surface; a green build does not mean a live host has passed conformance.

## Automatic foundation checks

`.github/workflows/foundation.yml` runs for pull requests, pushes to `master`
or `main`, and manual dispatch. It uses Node.js 22.18.0, the supported minimum.

The Worker job runs `npm ci`, `npm run typecheck`, `npm run build` and
`npm test` (the plain-Node smoke suite under `test/`) in the repository root.
A separate harness job runs `npm ci --ignore-scripts` and
`npm test` in `conformance/`. Neither job receives application credentials or
provisions/deploys cloud resources. Building the native Container images requires
a running Docker engine on the build runner. These are local image builds;
the workflow does not authenticate the configured remote runtime bindings.

## Manual live conformance

`.github/workflows/host-conformance.yml` has **only** a `workflow_dispatch`
trigger. There is no default host, fixture, or identity. It can exercise the
existing portal or an implemented host at an explicitly supplied reachable
origin. It does not start a local host, provision resources, or deploy code.

Prepare the disposable source and identities described in
[`conformance/README.md`](../conformance/README.md). Configure these GitHub
Actions **repository secrets** yourself; this change does not create secrets:

| Secret | Required identity |
| --- | --- |
| `TIMDS_CONFORMANCE_OWNER_TOKEN` | The fixture owner with a publisher grant for this disposable source |
| `TIMDS_CONFORMANCE_MEMBER_TOKEN` | A distinct member identity for join/claims/shared-write checks |

In GitHub Actions, choose **Disposable host conformance → Run workflow**,
select the reviewed branch, and supply:

| Dispatch input | Value |
| --- | --- |
| `host_url` | Explicit HTTPS origin reachable by the runner |
| `fixture_source_id` | The disposable source UUID |
| `fixture_system_id` | Its exact immutable system ID |
| `member_principal_id` | The principal UUID matching the member credential |
| `disposable_write_acknowledgement` | Exact `<fixture_source_id>:<fixture_system_id>` |

Required configuration is validated **before dependency installation or host
requests**. Missing secrets, an insecure external origin, or a mismatched
acknowledgement fail the job. Secrets are supplied only to the validation and
live-test steps; they are not put in workflow inputs or dependency-install
environments. A valid run performs real fixture edits, publications, rollback,
and a designer Request, as documented by the harness. It has a 90-minute job
budget and 15-minute per-operation polling limit. Runs for the same source are
serialized; new dispatches do not cancel an in-flight publication.

An `always()` upload step collects only the harness's ignored
`conformance/artifacts/*.json` receipts, with seven-day retention. These contain
resource UUIDs, operation/status counts, publication versions and cleanup
results; no credentials, source snapshots, request bodies or logs are uploaded.
Preflight failure produces no receipt. Inspect the job result and cleanup
outcome as well as the evidence; an uploaded artifact alone does not prove a
successful lifecycle.

## Local/deployed-host acceptance gate

The issue's full `cf dev` and deployed-host conformance gate remains pending
authenticated acceptance. The production-portal baseline passed locally (private operational record),
and the isolated native deployment is recorded (private operational record);
neither is a GitHub Actions or new-host lifecycle acceptance claim. There is no
simulated-host job advertised as live conformance. A local-host CI job must
explicitly start the real backing services and disposable resources, run the
same suite, and close those resources. `cf dev` uses a local runtime, but
Artifacts requires a remote disposable namespace. Follow the
[operations runbook](operations.md) to provision a host and disposable source.

## Action pins

All third-party workflow actions are GitHub's official actions pinned to commit
SHAs. The following release tags and commit references were verified through
the official repositories' GitHub API on October 12, 2026:

| Action | Release | Commit |
| --- | --- | --- |
| [actions/checkout](https://github.com/actions/checkout/releases/tag/v7.0.1) | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [actions/setup-node](https://github.com/actions/setup-node/releases/tag/v7.1.0) | `v7.1.0` | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| [actions/upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.2) | `v7.0.2` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
