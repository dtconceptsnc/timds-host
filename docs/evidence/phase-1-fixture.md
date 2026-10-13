# Phase 1 disposable portal fixture

**Status: fixture provisioned; production conformance has not run.**

Recorded on October 12, 2026 at 22:11 EDT
(`2026-10-13T02:11:44.832Z`). The production portal checkout inspected during
provisioning was `89b1b72`. This receipt covers readiness checks and fixture
creation only. It does not satisfy the issue #69 production-conformance gate
or claim that the separate issue #60 acceptance is complete.

## Fixture identity

| Item | Value |
| --- | --- |
| Name | `TimDS conformance 69` |
| Source / lifecycle operation | `c3e83a28-052d-468a-8b76-958e1dbf75b4` |
| System | `timds/6e5e5b99-1bf7-4c62-b425-5bbaef408941` |
| Dedicated organization | `63d28c0d-ce71-4f25-a319-b4696e1f7cf8` |
| Dedicated project | `ad5c7f43-0119-4fb3-a502-a6ba228f9cfd` |
| Artifacts namespace / repository | `timds-conformance-69/host-v1-conformance` |
| Lifecycle execution job | `7b02fbc3-1246-4b1e-867b-e5791c4b978b` |
| Scaffold toolkit resolved by normal lifecycle | `0.1.467` |
| Conformance client toolkit pin | `0.1.464` |

These UUIDs identify disposable resources, not credentials. No existing design
system, another agent's acceptance fixture, or client repository was used.

## Provisioning receipt

An isolated server-side script called the existing
`createDesignSystemLifecycle().prepareProvision()` with a new organization and
project context and idempotency key `timds-host-conformance-69-v1`. It used the
normal `reserve_artifacts_design_system_operation` lifecycle and existing
internal `POST /api/execution-jobs` enqueue route. There were no raw schema
writes, forged user credentials, bypassed review records, or production
service changes.

The normal worker was run once with this explicit scope:

```text
--project-id=ad5c7f43-0119-4fb3-a502-a6ba228f9cfd
--job-types=provision_design_system
--limit=1
--release-stale=false
--worker-id=timds69-conformance-provision
```

Result: one job selected, one succeeded, zero failed, first attempt. The
source's `lifecycle_status` and `sync_status` are both `ready`. It has no
published version, sessions, or publisher grants. No global stale-job cleanup
ran and no unrelated jobs were claimed.

## Read-only preview and build checks

Cloudflare read endpoints confirmed:

- The source-owned Worker exists and has its exact `timds-source:<source ID>`
  ownership marker.
- Workers.dev routing and branch previews are enabled.
- The Workers Builds connection identifies this exact Artifacts namespace,
  repository, and immutable repository ID, on `main`.
- Automatic builds and preview builds are enabled.
- The configured build command is `npm run build:preview`; current portal
  deployment commands are `npx wrangler deploy` and `npx wrangler preview`.
  These are the portal's existing prerequisite paths, not a claim that the
  extracted host's `cf` deployment workflow has passed.
- The server's Workers Builds credential is active and registered exactly once.
  No credential, token ID, or secret value is included in this receipt.

The [disposable preview Worker](https://timds-c3e83a28052d468a8b76958e1dbf75b4.ratebucket.workers.dev)
returned **503**, the expected initial placeholder awaiting its first
submission. A successful source build or submission preview has **not** been
proven by this readiness check.

## Read-only designer checks

The server has its runner URL, runner credential, and designer-principal
configuration. The configured designer principal is an active agent.
Cloudflare Worker settings expose all required binding names:
`LIVE`, `SANDBOX`, `REPOSITORY`, `TIMDS_SANDBOX_RUNNER_TOKEN`, and
`OPENAI_API_KEY`. Only presence was inspected/reported, never secret values.

An authenticated request to an intentionally nonexistent runner route returned
404, confirming that the runner accepted the existing server credential and
reached routing. This probe created no session or Durable Object and did not
start a model. A real designer Request remains part of the unexecuted suite.

The conformance transport also made an anonymous request for a nonexistent
session's public token CSS on this fixture. Its 404 error response passed the
vendored OpenAPI validator. This is only an error-contract smoke check.

## Outstanding acceptance inputs

The user's existing local CLI credential is source-scoped and the production
host correctly rejected it for identity-based session operations. The new
device authorization expired while approval was pending; it did not produce a
credential. No alternate owner credential was minted to bypass that approval.

Before running the suite:

1. Complete the user's own identity login and identify its principal.
2. Grant that identity publication rights for **this fixture only**.
3. Create or select a separate disposable member identity and short-lived
   credential for invitation, claim, and shared-writer assertions.
4. Verify the narrow portable-submissions identity-route correction is loaded
   by the production portal (subsequently satisfied by #77; see below).
5. Run the exact toolkit client suite against `https://timds.com`, inspect its
   redacted evidence, and verify resource cleanup before claiming conformance.

The isolated provisioning script and redacted runtime receipts are retained on
the portal host at `/tmp/timds69-provision-conformance.mjs`,
`/tmp/timds69-conformance-fixture.json`, `/tmp/timds69-readiness.mjs`, and
`/tmp/timds69-readiness.json`. Server credentials were read only in their
existing server process environment, not printed or copied into these files.
Remove the disposable source through the ordinary lifecycle after acceptance
and evidence review; do not delete its records directly.

## Subsequent compatibility update

The independent #60 acceptance landed the same submissions identity-route
correction in portal PR #77. Read-only verification found production checkout
`3a1a46c`, the authorization module updated at `2026-10-13T02:16:59Z`, and the
API service active since `2026-10-13T02:18:18Z`. The #69 portal branch rebased
onto that commit and removed its duplicate fix. This removes the compatibility
deployment prerequisite; it does not establish owner authentication, fixture
publication authority or a passing conformance run. No service was restarted
by this verification.
