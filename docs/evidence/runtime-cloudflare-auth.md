# Runtime Cloudflare authority

Reviewed 2026-10-13. No credential was created, broadened or copied into this
repository. Readiness results contain endpoint categories, status and numeric
provider codes only. This is distinct from the developer credential used to
build/push the native container images and deploy the API Worker.

## Required control calls

| Runtime surface | Calls in this implementation | Required authority |
| --- | --- | --- |
| Artifacts | Repository metadata, Git object/file reads, fork/create/delete, capability mint/list/revoke | Configured namespace binding; REST fallback requires Artifacts Read/Edit |
| Live and source Preview Workers | List scripts, upload owned script, read account subdomain, enable workers.dev, delete owned script | Workers Scripts Write (includes relevant reads) |
| Review branch Preview | Delete an owned branch Preview and inspect its metadata | Worker control authority; beta Preview endpoint still requires actual acceptance |
| Agent fork subscriptions | List, create and delete exact source-owned `artifacts.repo` subscriptions | Workers Scripts Write **or** Queues Write |
| Workers Builds | Read/create/delete owned connection, read triggers/previews, migrate connection to Previews | User-scoped Workers Builds Configuration Edit, plus Workers Scripts Read for Worker tags |
| Native storage/execution | D1, KV, R2, Queue sends, Workflow and Durable Object/container calls | Their deployed bindings; no runtime API token |

The existing Builds credential is registered as the deployment token used by
the successful cf Preview builds. That is stronger evidence for Workers write
permission than a successful list request. It is the existing candidate for
the remaining Worker/event REST calls after binding-based Artifacts access.
The exact deployed runtime still needs end-to-end acceptance; a local request
does not prove the Worker can make the same request.

Cloudflare documents `Workers Scripts Write` for
[upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/),
[delete](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/)
and [workers.dev activation](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/).
Both [subscription creation](https://developers.cloudflare.com/api/resources/queues/subresources/subscriptions/methods/create/)
and [deletion](https://developers.cloudflare.com/api/resources/queues/subresources/subscriptions/methods/delete/)
accept Workers Scripts Write or Queues Write. This runtime does not configure
zone routes, DNS or custom domains. Builds specifically requires a user-scoped
token; account-scoped tokens are unsupported. Its API caller token and registered
deployment token UUID are distinct concepts, even when one underlying credential
is deliberately used for both. See the
[Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/).

## Native Artifacts bindings and multiple organizations

The pinned `cf@1.0.0-beta.14`/`@cloudflare/config@0.24.1` exposes
`bindings.artifacts({ namespace, dev: { remote: true } })`. Phase 0 proved this
configuration locally and deployed. A binding authenticates deployed requests
without a Cloudflare API token. Its namespace is a deployment-time value, so an
explicit namespace-to-binding map can support several organizations without
granting an unbounded caller-selected namespace. An additional namespace must
be configured and deployed before accepting its source; the configured
namespace may initialize on its first repository creation, but a binding cannot
switch to an arbitrary namespace dynamically.

The API supports create/get/list/import/delete and disposable repository
handles for fork, token management and object/file reads. Dispose handles and
revoke automatic initial create/fork capabilities before returning durable repo
identity. Match the stored namespace and immutable repository identity before
granting a session access. See
[Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/).
The REST alternative requires Artifacts Read on reads and Artifacts Edit on
writes; Git itself uses separate, repository-scoped read/write capabilities.
See [Artifacts authentication](https://developers.cloudflare.com/artifacts/guides/authentication/).

## Sanitized observation

At 13:17 UTC, the generic server credential, the existing Builds credential and
the managed developer OAuth grant all returned HTTP 200 from namespace listing,
Worker listing and subscription listing. Builds token listing returned 401
`12006` for the generic credential, 200 for the Builds credential and 403
`10000` for managed OAuth. Subsequent exact-repository probes returned 403
`10004` for generic/Builds credentials and 200 for managed OAuth locally.
Managed OAuth nevertheless returned 403 from the deployed Worker using the
same effective credential and URL, as independently diagnosed during actual
publication preflight. Namespace listing is therefore **not** an Artifacts
readiness gate, and an expiring developer OAuth grant is not the durable fix.

Binding-first Artifacts and the existing long-lived Builds credential for
remaining control calls are being integrated with the same owned fixture.
No new token or permission expansion is required by this plan. Provider/runtime
acceptance, including owned-resource cleanup, remains the verification gate.
