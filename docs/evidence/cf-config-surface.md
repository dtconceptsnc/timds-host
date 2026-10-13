# Remaining `cf` configuration surface

Checked 2026-10-13 against installed `cf@1.0.0-beta.14`, its configuration
declarations, generated Workers types, and current official documentation.
No cloud resources were created. The isolated
[fixture](../../spikes/cf-config-surface/) passed `cf workers types`, TypeScript,
Vite build, and `cf deploy --dry-run`. This establishes configuration/build
acceptance; it does not claim live Workflow execution or OAuth integration.

## Workflows, OAuth KV, and assets

The fixture verifies this exact configuration shape (names and limits below
are illustrative, not host policy):

```ts
import { bindings, defineConfig, exports } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };
const worker = 'example-host', workflow = 'example-host-publication';
export default defineConfig({ worker: {
  name: worker, compatibilityDate: '2026-10-12', entrypoint,
  compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  exports: { PublicationWorkflow: exports.workflow({
    name: workflow,
    limits: { steps: 64 }, concurrency: { limit: 8 },
    defaultRetention: { successRetention: '7 days', errorRetention: '30 days' },
  }) },
  env: {
    PUBLICATIONS: bindings.workflow({ name: workflow, worker,
      exportName: 'PublicationWorkflow' }),
    OAUTH_KV: bindings.kv({ id: '<existing-namespace-id>' }),
    ASSETS: bindings.assets(),
    OBJECTS: bindings.r2({ name: 'example-host-objects' }),
  },
  assets: { notFoundHandling: 'single-page-application',
    runWorkerFirst: ['/api/*', '/oauth/*'] },
} });
```

The entrypoint must export a class extending `WorkflowEntrypoint<Env, Params>`;
its `run(event, step)` uses an async `step.do` callback. Workflow names are
account-unique. The same-Worker Workflow binding passed dry-run without the
Container DO self-binding workaround. Workflow instance retention is separate
from R2 release retention. [Configuration API](https://developers.cloudflare.com/cf/projects/cloudflare-config/)

KV options are **`id` and `dev` only**; `bindings.kv({ name: ... })` is invalid.
`bindings.kv()` is accepted for deliberate deployment-time provisioning. Keep
the key exactly `OAUTH_KV` for Workers OAuth Provider.
`global_fetch_strictly_public` is required when enabling Client ID Metadata
Documents. No provider version was installed/selected by this check; its actual
endpoint/PKCE/audience behavior needs pinned-package integration.
[Provider requirements](https://github.com/cloudflare/workers-oauth-provider)

Vite supplies assets from client build output/public directory; there is no
`assets.directory` in this config API. `env.ASSETS.fetch(request)` typechecks.
The example API patterns are incomplete host policy: every auth/control/MCP
route, including discovery and token endpoints, must reach the Worker before
SPA fallback. The earlier [Builds spike](./cf-preview-builds.md) proved real
static-asset production/Preview serving.

## R2 prefix retention and expiration

These are bucket settings, not `bindings.r2()` options. Both exact CLI request
shapes passed `--dry-run`, without an API mutation:

```sh
cf r2 buckets locks update example-host-objects --rules \
  '[{"id":"immutable-releases","enabled":true,"prefix":"releases/","condition":{"type":"Indefinite"}}]' \
  --dry-run
cf r2 buckets lifecycle update example-host-objects --rules \
  '[{"id":"expire-staging","enabled":true,"conditions":{"prefix":"staging/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":604800}}}]' \
  --dry-run
```

Locks use `condition`, top-level `prefix`, and `maxAgeSeconds` for age retention.
Lifecycle expiration uses `conditions.prefix` and `maxAge`. Both PUT operations
replace the complete rule collection: read/merge existing rules before applying.
Lock only immutable prefixes; current projections, staging, and caches need
separate prefixes. A top-level `releases/` layout permits one shared rule.
Prefixes are literal, not wildcard paths. Rules affect existing and new objects;
missing prefix locks the whole bucket. Enforcement was not tested live here.
[Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/),
[lifecycle schema](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/)

## Multi-organization Artifacts adapter

`bindings.artifacts({ namespace, dev: { remote: true } })` fixes a namespace.
The fixture typechecks two explicit bindings. Runtime `create`, `get`, `list`,
`import`, and `delete` act within it. `ArtifactsRepo.fork(name, opts)` also lacks
a target-namespace option. There is no dynamic `.namespace(org)` factory.
[Binding API](https://developers.cloudflare.com/artifacts/api/workers-binding/)

Use explicit per-organization bindings with redeployment, or an account-scoped
REST adapter whose namespace paths come from authorized, stored organization
mappings. The latter supports onboarding without adding Worker bindings.
These are its exact documented routes (implementation remains gated):

```text
POST /accounts/{account}/artifacts/namespaces
  {"namespace":"org-<stable-id>","jurisdiction":"us"}
GET  /accounts/{account}/artifacts/namespaces/{namespace}
POST /accounts/{account}/artifacts/namespaces/{namespace}/repos
  {"name":"source-<stable-id>","default_branch":"main"}
GET  /accounts/{account}/artifacts/namespaces/{namespace}/repos/{name}
POST /accounts/{account}/artifacts/namespaces/{namespace}/repos/{name}/fork
  {"name":"session-<stable-id>","default_branch_only":true}
POST /accounts/{account}/artifacts/namespaces/{namespace}/tokens
  {"repo":"session-<stable-id>","scope":"read","ttl":60}
DELETE /accounts/{account}/artifacts/namespaces/{namespace}/tokens/{token-id}
```

`cf artifacts namespaces create --namespace <name> --jurisdiction us` supports
explicit setup. Jurisdiction cannot change after creation: create explicitly
when location matters rather than allowing implicit namespace creation.
The prior live spikes proved namespace/repository provisioning and scoped Git
capabilities; no new resources were necessary for this check.
[REST routes](https://developers.cloudflare.com/artifacts/api/rest-api/),
[namespace semantics](https://developers.cloudflare.com/artifacts/concepts/namespaces/)

The future adapter must authorize the organization before selecting its namespace,
keep the control credential Worker-only, and reject caller-supplied provider
paths. Persist account, namespace, repo name and immutable provider repo ID.
Recover lost-response/duplicate operations by verifying a stored ownership
reservation and readback identity. Repository collision is code 10201; a generic
409 is not sufficient. Remote-binding errors can lose `.code` across RPC, as
observed in Phase 0, so normalize actual provider errors deliberately.

Create/fork/import returns secret `token`; token creation returns `id`, secret
`plaintext`, `scope`, `expires_at`. Never serialize raw responses into logs,
HTTP errors or D1. Revoke initial/short-lived capabilities in `finally`, including
identity-save failure; persist cleanup IDs only. Token indexes can require bounded
retry. Dispose binding repository handles with `using`; disposal and Git token
revocation are separate operations. Keep repository forks inside their owner's
namespace rather than assuming undocumented cross-namespace fork support.
