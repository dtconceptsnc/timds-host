# Local OAuth provider interoperability spike

This is a local-only protocol fixture for issue #69, using the actual
`@cloudflare/workers-oauth-provider` **1.2.3** in workerd through **cf
1.0.0-beta.14**. It is independent of the host's package, configuration, and
domain implementation. It has no deployment script. **Do not deploy it.**

The fixture automatically authorizes a fixed synthetic `fixture-user` after
the provider validates the OAuth request. This intentionally substitutes for
human sign-in and consent. It is not a production identity or security
implementation, and it proves neither Cloudflare Access integration nor host
domain acceptance.

## Run

Install this directory's locked dependencies and supply a toolkit checkout
that includes the OAuth client implementation from toolkit PR #100:

```sh
npm ci
npm run typecheck
npm run build
npm run smoke -- /absolute/path/to/timds-toolkit-oauth-worktree
```

The smoke starts and stops `cf dev` itself on `http://127.0.0.1:8798` and
refuses to reuse an occupied port. Vite listens only on `127.0.0.1`; the Worker
also requires that exact origin. The plugin disables persistence, remote
bindings, its inspector, and tunnels. The only application binding is a
local KV namespace. No deployment, remote KV, Cloudflare account resources,
or host domain services are used.

The toolkit creates its real ephemeral loopback callback server. The smoke
automates browser navigation to the synthetic `/authorize` handler, then
follows the provider's redirect to that callback. All discovery,
registration, authorization, token, refresh, and protected API requests use
real HTTP; no server responses are mocked. The temporary credentials file
uses the toolkit's normal atomic save and lock mechanism, is checked for
mode `0600`, and is deleted after the run. The runner also handles SIGINT and
SIGTERM. It prints only fixed check descriptions and version metadata;
provider subprocess output and raw exceptions are suppressed to avoid
printing authorization URLs or credentials. Do not set `TIMDS_ACCESS_TOKEN`
when running this test, because that would bypass saved credential lookup.

## What it checks

- Authorization-server and protected-resource metadata expose the agreed
  resource `http://127.0.0.1:8798/api/timds` and TimDS scopes.
- The real toolkit chooses OAuth through automatic discovery, dynamically
  registers a public client, sends PKCE S256, validates callback state and
  single use, exchanges the authorization code, and saves credentials.
- The protected handler receives the provider's verified audience, client,
  synthetic subject, and exact granted scopes. It never returns
  `ctx.auth.token`.
- Refresh requests with a different resource or client fail. The toolkit's
  successful refresh rotates the provider's refresh token, saves both new
  credentials, and uses the saved token on the next lookup.
- A read-only grant can read but receives `403 insufficient_scope` for the
  probe's write operation. The handler checks scopes itself:
  `requiredScopes` is advertised metadata, not automatic enforcement.
- The real provider rejects an altered PKCE verifier, and the failed
  toolkit login saves no credential.

The refresh test advances only the toolkit's injected expiry clock to
exercise its normal refresh path immediately. It does not alter provider
time, KV, or credential contents. Real access-token expiration over elapsed
wall-clock time is not tested. The protected probe changes no domain data.

## Receipt

On 2026-10-13, all eight checks passed using toolkit **0.1.470**, provider
**1.2.3**, and cf **1.0.0-beta.14**. `npm run typecheck` and `npm run build`
also passed.
The runner emits the exact commit and timestamp for subsequent runs.

This is a Phase 1 client/toolchain compatibility result only. It does not
complete Phase 5 OAuth acceptance, deployed host authentication, real browser
consent, Access user/service identity mapping, CIMD, principal revocation,
multi-process refresh testing, or any production conformance gate. The
toolkit's separate tests cover its credential-file concurrency behavior.

The provider and Cloudflare Vite plugin dependencies are MIT-licensed; the
lockfile records exact transitive resolutions. Their implementations remain
dependencies rather than copied source.
