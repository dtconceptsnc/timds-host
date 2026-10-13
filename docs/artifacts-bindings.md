# Artifacts namespace bindings

Runtime repository operations use native Cloudflare Artifacts bindings. Declare
an explicit namespace-to-binding map when running `cf dev`, generating types,
building, or deploying:

```sh
export TIMDS_ARTIFACTS_BINDINGS='{"organization-a":"ARTIFACTS_ORG_A","organization-b":"ARTIFACTS_ORG_B"}'
npm run typecheck
npx cf deploy
```

Each key is the exact namespace stored on its sources. Each value is a distinct
`ARTIFACTS_`-prefixed binding name. The configuration generates one static
`bindings.artifacts({namespace, dev:{remote:true}})` per entry and passes the same
map into the Worker. Local development therefore operates on real, explicitly
selected namespaces. Choose disposable namespaces for development.

The default map is empty. Provisioning and repository access fail with a
configuration error for an unbound namespace. Add the organization's namespace
and deploy before provisioning or importing its sources. Creating an organization
in D1 does not grant a binding or silently authorize arbitrary namespaces.

The namespace binding supports repository creation, fork, fresh identity reads,
Git capability creation/revocation, Git-object reads, and deletion. Its safe
adapter output retains the exact provider repository ID. Every capability handle
is disposed before the operation returns. Token revocation requires the exact
repository name; it never searches other repositories for a token. Incomplete
token inventories fail closed. Creation immediately revokes the initial provider
capability before returning safe metadata.

`getNamespace` checks the configured binding with a bounded repository-list
request. If no namespace exists yet, `createNamespace` returns an explicit
`implicit-on-repository-create` receipt; the first repository creation creates
that namespace through Cloudflare. It does not claim that a namespace-only API
write occurred. Namespace listing without REST enumerates configured bindings,
not every namespace in the account.

A deliberately configured external control-plane integration may set
`TIMDS_ARTIFACTS_REST_FALLBACK=true` together with its server-only Artifacts API
credential. Only unbound namespaces use this fallback. Binding errors are never
retried through REST. Ordinary host runtime operation does not require a
Cloudflare API token for bound repository namespaces. Builds, Workers lifecycle,
and event-subscription APIs still use their separately configured credentials.

References: [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[authentication](https://developers.cloudflare.com/artifacts/guides/authentication/),
and [namespace creation](https://developers.cloudflare.com/artifacts/concepts/namespaces/).
