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
`eec5b502-381e-4ad1-994b-b2b19e063cf7`, also including external-push
reconciliation, callback-origin CSP, same-origin consent referrer policy and
the configured designer principal and `gpt-6-sol` model, metadata read facade,
and bounded publication/Request diagnostics.
Anonymous API access returns 401; its health route returns 200 and deliberately
reports `ready:false, phase:integration`. The public companion rejects API paths
with 404 and successfully initializes the anonymous read MCP server with
protocol `2025-03-26`.

The deployment consumes existing operator Cloudflare, Builds and OpenAI
credentials directly in process memory. Secret values were supplied to cf
through a private FIFO and were never written into the project or evidence.
The one-time bootstrap credential is separately controlled by the root agent.

This proves deployed native wiring and public read service isolation. It does
**not** claim the authenticated host conformance suite has passed. Human OAuth,
administrator bootstrap, organization/designer creation and source provisioning
have since succeeded; session/Studio/publication and migration acceptance remain
in progress.

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

The same-origin HTTPS Studio OAuth callback also completed normally after the
referrer-policy correction. Administrator bootstrap, organization creation and
designer-principal creation succeeded through the authenticated API. The latest
deployment’s settings readback confirms designer principal
`789e056d-9120-4fb3-8610-5a10df98911d`. The isolated source provisioning returned
ready. Subsequent session and Studio acceptance remain in progress.

The toolkit callback listener was hardened separately to wait for response
finish/disconnect and drain connections before shutdown, with a five-second
forced-close bound for stalled connections. Typecheck and package dry-run passed;
this is not yet a verified explanation/fix for Chrome’s loopback landing display.
The latest deployment includes the Studio mobile topbar fix and bounded read
timeout recovery, file-export timeout, obsolete-read guards and field labels.
Live HTML, JavaScript and CSS match the local files at verification.

The first designer Request returned HTTP 500 before durable reservation. The
D1 request table existed but initially contained no row for that Request ID. A
diagnostic deployment exposes only an allowlisted operation/stage/error class.
The exact same-ID, same-instruction retry was then accepted and GET returned
200/queued. Its durable reservation binds the expected source, human and designer
principal. The initial failure did not reproduce; its cause remains unproven. An actual local workerd invocation with the same compatibility
settings confirms global Buffer and Buffer.byteLength are available.

The Request then reached dead-letter without creating a session. Its persisted
diagnostic and the independent CLI submission both identified Preview worker-list
fetch throwing TypeError/502 before any HTTP response. A native local workerd
invocation with the exact deployment compatibility settings reproduced that
`redirect:'error'` is rejected, while `redirect:'manual'` reached the API
(HTTP 400 using a deliberately invalid anonymous probe credential). The deployed
fix uses manual for both Preview fetches and publication public-stamp verification;
existing status checks reject redirects. Node container fetches are unchanged.
Typecheck, native build and deployment passed. The original CLI submission
`189cf3bd-5082-4c9e-8a47-f74094139f83` then succeeded and its branch Preview
rendered the real Overview. The original Request created native session
`9fce67ce-39fb-462d-8fee-b549e167b8d0`, entered running, then failed in its
runner. Its dispatch job completed; the failed runner remains an immutable audit
record. The initial pre-reservation 500 remains a separate unproven failure.

Inspection found the host had omitted the `MODEL` binding that the ported
runtime passes to Codex. The configuration now binds `gpt-6-sol` by default
and supports `TIMDS_DESIGNER_MODEL`; missing model configuration fails before
launch. Failed results also retain the existing allowlisted task diagnostics.
Typecheck and cf deployment passed; settings readback confirms `gpt-6-sol`.
Fresh disposable Request `a8d19bc9-11cb-4d60-93e5-591999562bf3` was accepted
from Studio on the new version. It created native session
`bea77f26-c8be-4363-8740-302e0a4098d5`, ran the configured model, and reached
`submitted` at `2026-10-13T12:30:52.734Z` with submission
`0da402f3-da45-4160-b952-2ad7ce63c9a2` and no error. This verifies the native
runner, bounded change collection and completion callback through a real Request.
The original failed Request is retained unchanged for audit.
