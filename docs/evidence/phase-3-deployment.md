# Isolated native host deployment

Both Workers are deployed through pinned `cf@1.0.0-beta.14` on October 13,
2026. The [sanitized receipt](./phase-3-deployment.json) contains exact Worker
versions, image digests, owned resource IDs, and HTTP results.

- API: https://timds-host-69.ratebucket.workers.dev
- Public reads: https://timds-host-69-public.ratebucket.workers.dev

The API Worker exports SystemCoordinator, RepositorySandbox, LiveSession,
BuildSandbox, DependencySandbox, PublicationWorkflow and the PublicRoots service.
Four configured native Container applications use the three image digests in
the receipt. The public Worker has only a binding to PublicRoots.

The dedicated D1 catalog applied all 18 statements in `0001_catalog.sql`.
Dedicated SNAPSHOTS and RELEASES buckets and the event Queue were provisioned;
cf deployed OAuth KV, Workflow and Queue producer/consumer bindings. RELEASES
readback confirms an enabled indefinite bucket lock for `sources/`, before any
publication can run.

All image builds, pushes, container preparation and deployments completed.
The final recorded API deployment includes the corrected repository transfer
deadline, trusted Studio static assets, approved Access configuration and frozen
source-provisioning input/retry receipts. It is version
`4de6f130-b68f-4e74-8434-b1e941a913cc`, also including external-push
reconciliation, callback-origin CSP and same-origin consent referrer policy.
Anonymous API access returns 401; its health route returns 200 and deliberately
reports `ready:false, phase:integration`. The public companion rejects API paths
with 404 and successfully initializes the anonymous read MCP server with
protocol `2025-03-26`.

The deployment consumes existing operator Cloudflare, Builds and OpenAI
credentials directly in process memory. Secret values were supplied to cf
through a private FIFO and were never written into the project or evidence.
The one-time bootstrap credential is separately controlled by the root agent.

This proves deployed native wiring and public read service isolation. It does
**not** claim the authenticated host conformance suite has passed: administrator bootstrap, authenticated container operations,
publication and migration acceptance are subsequent gates.

OAuth authorization-server and path-specific RFC 9728 resource discovery both
return 200 with the deployed origin. The authorization server advertises code
and refresh grants, PKCE S256, CIMD, and read/write/offline scopes. The anonymous
401 challenge links to the exact protected-resource metadata path. `/authorize`
and `/service-auth` now redirect to the configured Cloudflare Access login (302);
they previously failed closed with 503 before Access configuration.
The root protected-resource metadata path returns 404 because this resource is
explicitly `/api/timds`; that is expected path-specific discovery behavior.

The Studio page, module and stylesheet return 200 with the exact local SHA-256,
correct MIME, `Cache-Control: no-store`, restrictive CSP and `nosniff`. `/`
redirects to `/studio/`; `/README.md` and `/app.js` return 404. The browser
acceptance agent has the live origin; CLI credential acceptance is recorded below.

A fresh Chrome OAuth flow reached consent but initially ended with
`ERR_BLOCKED_BY_CLIENT` after Connect, leaving no CLI credential. The consent
page had `form-action 'self'`, which Chromium also enforces on the subsequent
redirect. The deployed correction adds only the OAuth library-validated
callback origin (including its exact loopback port), rejects CSP metacharacters
and wildcards, and retains the existing consent binding, PKCE and other CSP
directives. Typecheck, native cf build and deployment passed. A fresh browser
flow after deployment still produced `ERR_BLOCKED_BY_CLIENT` and no CLI
credential, so CSP has not been established as the cause and this change did
not resolve the login failure. Browser/request diagnostics are continuing. See
[MDN form-action redirect behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action).

Chrome Network subsequently captured an actual HTTP 403 for the consent POST,
also reproduced with the same-origin Studio callback. The consent GET used
`Referrer-Policy: no-referrer`, which the Fetch standard specifies serializes
Origin as `null` for non-CORS navigation POSTs, conflicting with the server’s
exact Origin check. The latest deployment changes only the consent GET to
`Referrer-Policy: same-origin`: same-host POST Origin is preserved and referrers
to cross-origin callbacks remain omitted. The Origin guard is unchanged.
Typecheck, build and deployment passed. The fresh CLI flow then exited 0 with
`authorization saved`, persisted its credential, and `scripts/admin.mjs me`
returned HTTP 200 for human principal `cca20844-e655-40dc-92f5-a51a9ee6b206`
with `admin:false`. This proves code exchange, credential persistence and
authenticated API access. The browser reached the loopback callback but still
displayed `ERR_BLOCKED_BY_CLIENT`; that landing-page issue is separate from the
successful token exchange and is under investigation. [Fetch Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header).

Read-only request diagnostics found Worker observability unset. The discovered
`cf o11y telemetry query` command returned HTTP 403/code 10000 using both
existing operator OAuth profiles. No logging settings were changed. A count-only
inspection of the dedicated OAuth namespace showed zero grant keys and three
consent keys during the failed attempts; no credential values were read.
