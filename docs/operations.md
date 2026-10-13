# Operate a TimDS host

These commands target the repository's pinned `cf@1.0.0-beta.14`. They reproduce
the [isolated deployment](evidence/phase-3-deployment.md), whose authenticated
acceptance is still in progress. Use a fresh installation name and disposable
source for initial acceptance. Existing-system import/cutover is separate;
provisioning below does not adopt existing repositories.

For a collaborator who has not signed into the host, use
[explicit source access invitations](access-invitations.md). Apply migration
`0004_access_invitations.sql` before enabling
`TIMDS_ACCESS_INVITATIONS_ENABLED=true`; it defaults off. The collaborator must
authenticate themselves through the configured Access policy. Historical portal
identity mappings never stand in for that person's verified login.

## Prerequisites and configuration

Install Node.js 22.18+ and npm, and start a local Docker engine capable of
building Linux AMD64 images. `cf build` and `cf deploy` build the native Sandbox
images locally. Production runs in Cloudflare Workers/Containers, not on the
machine building the images. No VPS runtime or global Wrangler install is needed.

```sh
npm ci
npm --prefix public-worker ci
```

Authenticate the project CLI with `npx cf auth login`, or supply an existing
deployment credential in the child process environment. The deployment identity
needs access to Workers, Containers/image registry, D1, R2, KV, Queues and
Workflows in the selected account. A Workers/Builds-only OAuth profile was
insufficient for D1, R2, Artifacts and container push in the recorded proof.
Keep deployment credentials separate from the long-lived runtime credentials.

Set and preserve this **nonsecret** environment for every API deployment:

```sh
export TIMDS_WORKER_NAME='timds-example'
export CLOUDFLARE_ACCOUNT_ID='<account-id>'
export TIMDS_HOST_ORIGIN='https://timds-example.<workers-subdomain>.workers.dev'
export TIMDS_STUDIO_ORIGIN='' # optional additional exact HTTPS origin for Studio
export TIMDS_PUBLIC_ORIGIN='https://timds-example-public.<workers-subdomain>.workers.dev'
export TIMDS_AGENT_PUSH_QUEUE_ID='<queue-id-from-next-step>'
export TIMDS_ARTIFACTS_BINDINGS='{"example":"ARTIFACTS_EXAMPLE"}'
export TIMDS_ARTIFACTS_REST_FALLBACK='false'
export TIMDS_ACCESS_TEAM_DOMAIN='https://<team>.cloudflareaccess.com'
export TIMDS_ACCESS_AUD='<access-application-audience>'
export TIMDS_DESIGNER_PRINCIPAL_ID=''
export TIMDS_DESIGNER_MODEL='gpt-6-sol'
export TIMDS_STUDIO_FRAME_ORIGINS='https://*.<workers-subdomain>.workers.dev'
```

The Worker name must match `[a-z0-9][a-z0-9-]{0,48}`. Both origins are exact
origins without a path. Use the full HTTPS Access team URL. Before Access exists,
leave its two settings empty: interactive authentication fails closed. Set them
and redeploy after configuring the application. Leaving origin/account/queue
settings unset on a later deployment replaces their values with defaults;
retain the installation's environment outside the checkout.

`TIMDS_STUDIO_FRAME_ORIGINS` is the only list of origins Studio may embed in
`<iframe>`s (its CSP `frame-src`): live views of sessions and drafts, and
submission Previews. Use space-separated `https://` origins or one-level
wildcard patterns, each matching `^https://(\*\.)?[a-z0-9.-]+$`. Today that is
the account's own `workers.dev` subdomain (`https://*.<workers-subdomain>.workers.dev`);
later, whatever custom domain masks live and Preview URLs. Nothing wider:
`https://*.workers.dev` and `https://*.pages.dev` are refused, as is any token
that does not match. Invalid tokens are dropped silently; an empty or wholly
invalid setting yields `frame-src 'none'`, and Studio then shows an
open-in-new-tab card instead of each frame. Studio itself keeps
`frame-ancestors 'none'`. The framed live and Preview responses must in turn
allow Studio's origin in their own `frame-ancestors` (see the Studio section of
the [architecture](architecture.md)).

The Artifacts map binds each approved organization namespace to one unique
`ARTIFACTS_...` binding. Add and deploy a namespace entry before provisioning or
importing its sources. Unconfigured namespaces fail closed. Runtime repository
operations use the native binding, not a developer OAuth token; the namespace
can initialize on its first repository creation. Keep REST fallback disabled
unless explicitly operating a separately validated Artifacts API credential.

Native source media uses its own mutable bucket and source-bound transfer
capabilities; see [media operations](api/media.md) for limits, imported bucket
bindings, CORS, cancellation and scoped deletion.

## Create storage and the event queue

These create commands are for a **new installation**. Record the resource IDs;
on subsequent deployments reuse the owned resources instead of creating more.

```sh
npx cf queues create --queue-name "${TIMDS_WORKER_NAME}-events"
npx cf d1 create --name "${TIMDS_WORKER_NAME}-catalog"
npx cf r2 buckets create --name "${TIMDS_WORKER_NAME}-snapshots"
npx cf r2 buckets create --name "${TIMDS_WORKER_NAME}-releases"
npx cf r2 buckets create --name "${TIMDS_WORKER_NAME}-media"
```

Set `TIMDS_AGENT_PUSH_QUEUE_ID` to the returned `queue_id`, and
`TIMDS_CATALOG_ID` to the D1 `uuid`. Apply the catalog migration from the root:

```sh
npx cf d1 query "$TIMDS_CATALOG_ID" --body "$(node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.stringify({sql:readFileSync("migrations/0001_catalog.sql","utf8")}))')"
```

The recorded initial migration applied 18 statements. Passing SQL through
`--body` avoids the beta CLI interpreting its leading comment as an option.
Future schema changes need their own reviewed migration; do not replace catalog
state to repair a deployment.

Before any publication, apply and read back the lock on the new RELEASES bucket:

```sh
npx cf r2 buckets locks update "${TIMDS_WORKER_NAME}-releases" \
  --rules '[{"id":"immutable-releases","enabled":true,"prefix":"sources/","condition":{"type":"Indefinite"}}]' \
  --force
npx cf r2 buckets locks get "${TIMDS_WORKER_NAME}-releases"
```

Require the enabled `sources/` rule and `Indefinite` condition. This sets the
bucket's rule collection; use it on this dedicated new bucket, not a shared
bucket with other rules. Released bytes and provenance are copied to
`sources/<source-id>/v/<version>/` and verified before pointer publication.
Snapshots stay in SNAPSHOTS. A release label cannot be reused for different
bytes or a different source commit.

## Runtime secrets and deployment

Have your secret manager write a private flat JSON file outside the repository
(owner-only directory and file mode `0600`) with these runtime keys:

| Key | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Optional explicit Artifacts REST fallback only; native namespace bindings do not need it |
| `TIMDS_BUILDS_API_TOKEN` | Active long-lived user API credential with Workers Scripts Write and Workers Builds Configuration Edit; registered exactly once as the Builds deployment token; also controls owned Preview/live Workers and Queue event subscriptions |
| `OPENAI_API_KEY` | Live designer execution |
| `TIMDS_BOOTSTRAP_SECRET` | Fresh random installation-only secret for the first human administrator |

The Builds credential must pass `/user/tokens/verify` and match exactly one
`cloudflare_token_id` in `/builds/tokens` with a `build_token_uuid`. Register the
intended deployment credential through Cloudflare's Builds setup before using
previews; `npx cf builds tokens list` lists registration metadata. A temporary
CLI OAuth token is not a replacement for this registered runtime API token.
Workers Scripts Write also authorizes event subscription creation/deletion, so
a separate Queues Write grant is not required for those calls. No zone/DNS
permissions are needed for workers.dev previews. See the exact
[runtime authority inventory](evidence/runtime-cloudflare-auth.md).
Do not paste credential-bearing Artifacts repository-create responses: creation
issues a capability. The host captures and revokes that initial capability.

Keep the bootstrap value in a separate private file for the bootstrap command.
Secrets go into Worker secret bindings, never `bindings.text`, Vite variables,
the source repository or shell arguments. The verified deployment also accepts
a `0600` FIFO supplied by a secret manager in place of the JSON file.

```sh
export TIMDS_SECRET_FILE='/absolute/private/path/runtime-secrets.json'
npm run typecheck
npm run build
npx cf deploy --secrets-file "$TIMDS_SECRET_FILE"
```

`cf deploy` builds/uploads images, prepares the four Container applications,
deploys DO exports and the Workflow, and provisions OAuth KV and Queue bindings.
Record its Worker version and verify the origins. Same-Worker calls use
`ctx.exports`; initial deployment needs no manual DO migration command.

After the API exports `PublicRoots`, deploy the companion with the **same**
`TIMDS_WORKER_NAME` in the environment:

```sh
npm --prefix public-worker run build
npm --prefix public-worker run deploy
```

The companion is `${TIMDS_WORKER_NAME}-public`. It has only the `PublicRoots`
service binding and receives no API/OAuth/provider secrets. For redeployment,
repeat the API command with the preserved environment and current secret file;
deploy the companion when its own code/configuration changes.

## Access, OAuth and administrator bootstrap

Create a dedicated self-hosted Cloudflare Access application for exactly these
API-host paths: `/authorize`, `/bootstrap`, `/service-auth`. Use the intended
human identity provider and explicit allowed humans, plus a dedicated host
service token only if machine identities are needed. Keep discovery, `/register`,
`/token` and `/api/timds` reachable: OAuth protects the API itself. Applying an
Access policy to the entire host blocks OAuth clients.

An optional `TIMDS_STUDIO_ORIGIN` adds one exact HTTPS origin for Studio without
changing `HOST_ORIGIN` or existing CLI/portal connections. Attach that hostname
as a custom domain on the API Worker, and add its `/authorize`, `/bootstrap`,
and `/service-auth` destinations to the same Access application, preserving its
audience and policies. Keep this variable in the installation's deployment
environment. OAuth discovery, consent and token resources remain bound to the
origin used for that connection; users sign in again on the new address. Other
origins remain rejected. The Studio origin is also allowed for public media CORS.

The following emits a reviewable application/policy JSON plan; it does not
create an Access application or credentials. Replace the example email/IDs with
the installation's selected identities and apply the reviewed plan in Cloudflare:

```sh
node scripts/access-plan.mjs --host-origin "$TIMDS_HOST_ORIGIN" \
  --name 'TimDS example authentication' --email 'operator@example.com' \
  --identity-provider-id '<idp-uuid>' --service-token-id '<host-only-service-token-uuid>'
```

This packaged plan includes both human and service policies. For a human-only
installation, create the same three-path application in the dashboard with only
the human policy; no service token is required.

Set the resulting `TIMDS_ACCESS_AUD` and `TIMDS_ACCESS_TEAM_DOMAIN` and redeploy
the API. `/authorize` and `/service-auth` should redirect anonymous browsers to
Access, while discovery stays public and anonymous API calls return 401.

OAuth support shipped in `@dtconcepts/timds@0.1.471`
([merged change](https://github.com/dtconceptsnc/timds-toolkit/pull/100)).
Use that published CLI for login; the native merge/build container remains
pinned to its validated `0.1.464` release.

```sh
npx --yes --package @dtconcepts/timds@0.1.471 timds auth login \
  --portal-url "$TIMDS_HOST_ORIGIN" --oauth
node scripts/admin.mjs me --host "$TIMDS_HOST_ORIGIN"
node scripts/admin.mjs bootstrap --host "$TIMDS_HOST_ORIGIN" \
  --operation-id '<stable-bootstrap-uuid>' \
  --secret-file '/absolute/private/path/bootstrap-secret'
```

Complete Access sign-in and OAuth consent in the browser on the CLI machine.
The CLI uses PKCE S256 and a loopback callback, and stores credentials outside
the checkout. The administration script reads that store without printing
tokens; `--credentials` selects a nondefault store. It requires a fresh,
nonexpired access token and does not refresh it: rerun OAuth login if needed.
The first identity starts without administrator privileges. Bootstrap consumes
one durable installation reservation; retry only with the same identity and
operation UUID. Verify `principal.admin: true`, then remove the separate local
bootstrap file after retaining the nonsecret receipt. A second bootstrap does
not create another administrator.

An optional service identity obtains its Access assertion at `/service-auth`
and sends that assertion to the API. That response contains a credential;
keep it in memory, never logs. The identity still needs explicit source grants.

## Organization, designer and fresh system

Save administrative request bodies outside the source tree and keep their
operation IDs and exact contents stable across interrupted retries. Examples
use `apiVersion: 1`; `scripts/admin.mjs` supplies the API-version header.

Create `organization.json` with `{"apiVersion":1,"id":"<organization-uuid>","name":"Example"}`:

```sh
node scripts/admin.mjs organization --host "$TIMDS_HOST_ORIGIN" --input /absolute/path/organization.json
```

For designer Requests, create `agent.json` with
`{"apiVersion":1,"id":"<stable-agent-uuid>","name":"Designer"}`:

```sh
node scripts/admin.mjs agent --host "$TIMDS_HOST_ORIGIN" --input /absolute/path/agent.json
```

Set `TIMDS_DESIGNER_PRINCIPAL_ID` to the **returned** `principal.id` and redeploy.
This internal principal has no blanket publisher rights; designer Requests
remain tied to the initiating human's current source authority.

Choose and record a fresh source UUID, provisioning operation UUID, organization
UUID, immutable system ID, namespace and repository name. Namespace/repository
names use lowercase letters, digits and hyphens. The namespace must already
appear in the deployed `TIMDS_ARTIFACTS_BINDINGS` map. Initialize a fresh standalone
seed with the host's pinned toolkit, then convert its Preview tooling to `cf`:

```sh
export TIMDS_SEED_ROOT='/absolute/path/fresh-design-system'
node node_modules/@dtconcepts/timds/bin/timds.mjs init \
  --root "$TIMDS_SEED_ROOT" --standalone --provider hosted \
  --portal-url "$TIMDS_HOST_ORIGIN" --system-id 'example/core' --name 'Example core'
npm --prefix "$TIMDS_SEED_ROOT" install --save-dev --save-exact @dtconcepts/timds@0.1.464 --ignore-scripts --no-audit --no-fund
node scripts/prepare-preview-source.mjs --source "$TIMDS_SEED_ROOT" \
  --worker 'timds-<source-uuid-with-hyphens-removed>'
node scripts/prepare-preview-source.mjs --source "$TIMDS_SEED_ROOT" \
  --worker 'timds-<source-uuid-with-hyphens-removed>' --apply
git -C "$TIMDS_SEED_ROOT" init
git -C "$TIMDS_SEED_ROOT" add --all
```

The conversion first prints a plan. `--apply` updates the lockfile, runs the
Preview build and `cf build`, and compares every emitted asset's bytes. It makes
no cloud deployment. Review the staged seed; exclude credentials, dependencies,
`.git`, generated output and unrelated files.

Create `provision.json` with this shape. Each file is a tracked seed file with
its exact bytes encoded as base64; preserve executable modes. For a symlink,
encode the link target text with mode `120000`. Supply the real file array,
including `timds.json`, package/lock files, source and build scripts:

```json
{
  "apiVersion": 1,
  "operationId": "<stable-provisioning-uuid>",
  "sourceId": "<fresh-source-uuid>",
  "organizationId": "<organization-uuid>",
  "systemId": "example/core",
  "namespace": "example-org",
  "repository": "core",
  "name": "Example core",
  "grantPublisher": true,
  "files": [
    {"path":"timds.json","mode":"100644","encoding":"base64","content":"<base64-file-bytes>"}
  ]
}
```

After filling the non-file fields, this fills the array from the exact staged
Git blobs, including binary bytes and symlink targets. Run it once before the
first provisioning attempt; keep its resulting body unchanged for retries:

```sh
export TIMDS_PROVISION_INPUT='/absolute/path/provision.json'
node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const git = (...args) => execFileSync('git', ['-C',process.env.TIMDS_SEED_ROOT,...args], {maxBuffer:16*1024*1024});
const input = JSON.parse(readFileSync(process.env.TIMDS_PROVISION_INPUT,'utf8'));
input.files = git('ls-files','--stage','-z').toString('utf8').split('\0').filter(Boolean).map(row => {
  const tab = row.indexOf('\t');
  const [mode,object,stage] = row.slice(0,tab).split(' ');
  if(stage !== '0' || !['100644','100755','120000'].includes(mode)) throw new Error('Resolve unsupported or conflicted seed entries first');
  return {path:row.slice(tab+1),mode,encoding:'base64',content:git('cat-file','blob',object).toString('base64')};
});
writeFileSync(process.env.TIMDS_PROVISION_INPUT,JSON.stringify(input,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({sourceId:input.sourceId,operationId:input.operationId,fileCount:input.files.length}));
JS
```

The manifest's `systemId` must match the request. The server validates paths and
total change-set size before creating resources. Submit the saved request:

```sh
node scripts/admin.mjs provision --host "$TIMDS_HOST_ORIGIN" --input /absolute/path/provision.json
```

Require `source.lifecycle_status: "ready"` and the expected source/system IDs.
The server freezes file bytes and `grantPublisher` with the operation, saves the
repository identity, initializes it through the native repository container,
and grants the initiating human read/write/publish when requested. A retry must
reuse the **identical body and IDs**. An existing repository without this
operation's owned receipt is rejected; do not delete or adopt it as a workaround.

Grant another already-created principal access with a saved `grant.json`:

```json
{"apiVersion":1,"operationId":"<stable-grant-uuid>","command":{"principalId":"<principal-uuid>","read":true,"write":true,"publish":false}}
```

```sh
node scripts/admin.mjs grant --host "$TIMDS_HOST_ORIGIN" \
  --source-id '<source-uuid>' --input /absolute/path/grant.json
```

Administrator status is not an implicit publication grant. Open `/studio/` or
use the OAuth-capable CLI to start a session on `example/core`. Provisioning
does not publish it. Run the [live conformance lifecycle](../conformance/README.md)
against this disposable source before onboarding production systems.

Read current publishers and existing host identities through the same signed-in
administrator, without handling bearer tokens manually:

```sh
node scripts/admin.mjs publishers --host "$TIMDS_HOST_ORIGIN" --source-id '<source-uuid>'
node scripts/admin.mjs principals --host "$TIMDS_HOST_ORIGIN" --source-id '<source-uuid>'
```

Each read returns at most 200 entries. When `nextPublisherCursor` or
`nextPrincipalCursor` is non-null, pass that exact value as `--cursor` for the
next page. Only host identity UUID, name, type and status are exposed. No email
matching creates identities or grants. Revoke a publish grant with the same
saved `grant.json` shape and `publish:false`, using a new operation UUID for the
new intent. Keep that UUID and body unchanged through an uncertain retry.

Archive and restore use durable coordinator authority operations:

```sh
node scripts/admin.mjs archive --host "$TIMDS_HOST_ORIGIN" \
  --source-id '<source-uuid>' --operation-id '<stable-archive-uuid>'
node scripts/admin.mjs restore --host "$TIMDS_HOST_ORIGIN" \
  --source-id '<source-uuid>' --operation-id '<stable-restore-uuid>'
```

Both require a current active host administrator and an initialized source.
Archive disables public serving, new authoring and publication authority while
retaining its repository, grants, release history and session records. Restore
re-enables the same source identity. Current administrator metadata reads remain
available for archived sources; ordinary authoring and publisher grants do not
bypass archive. These operations do not delete cloud resources or change the
portal's separately owned catalogue metadata. Existing immutable release bytes
remain protected by their bucket locks even when a source is later deleted.

The portal's connected-source operator UI uses these same source-bound routes
only after verified transfer. The connected human needs host admin authority;
being a portal operator does not confer it. Archive/restore and grant controls
retain operation IDs on failed requests. Source archive and release state come
from the host, while catalogue edits remain under portal permissions.

## Verify and operate

Check anonymous responses after deployment:

| API-host path | Expected result |
| --- | --- |
| `/health` | 200; currently reports `ready:false, phase:integration` (not an acceptance signal) |
| `/.well-known/oauth-authorization-server` | 200; exact issuer and code/refresh grants |
| `/.well-known/oauth-protected-resource/api/timds` | 200; exact `/api/timds` resource |
| `/api/timds/design-systems` | 401 with the path-specific resource-metadata challenge |
| `/studio/`, `/studio/app.js`, `/studio/style.css` | 200, correct MIME, `no-store`, CSP and `nosniff` |
| `/` | Redirect to `/studio/` |
| `/README.md`, `/app.js` | 404 |

The public companion rejects `/api/timds/*` with 404 and exposes anonymous read
MCP at `/mcp`. Published roots are `/systems/<URL-encoded-system-id>/`, with
`/v/<version>/` for immutable versions. Check `.timds-artifact.json` stamps and
referenced asset digests after publication/rollback; a 200 health response is
not publication acceptance.

Workflows checkpoint source/build/release receipts and commit the pointer once.
An interrupted post-pointer verification resumes verification/cleanup; it does
not rerun publication. Use the original publication ID when diagnosing recovery.
Keep source/release identity and event correlation intact; do not clear
coordinator or catalog state to force a retry.

For existing systems, recapture the
[migration baseline](evidence/migration-baseline.md) immediately before migration,
preserve historical first-event version bindings and public domains, and verify
all required public bytes before cutover. The baseline is read-only evidence,
not an import or cutover receipt.

## Pinned cf limitations

The deployed workerd runtime rejects `fetch(..., {redirect:'error'})` with a
TypeError before network I/O. Worker-side Preview and public-stamp fetches use
`redirect:'manual'` and reject non-success statuses; they never follow redirects.
This was reproduced in the local native runtime with the deployed compatibility
date and flags after live Request/submission diagnostics identified the failing
Worker-list call. Node container programs retain Node's supported redirect mode.

- Use `cf dev` for the local runtime. The tested Vite path does not support
  `cf dev --local`. Artifacts has no local emulator: the host's REST adapter
  still uses remote disposable resources; the native binding spike uses
  `dev: { remote: true }`. Local and deployed acceptance are separate.
- The same-Worker container DO env binding emitted a misleading `script_name`
  and failed cf validation. The implemented configuration uses exported DOs
  through `ctx.exports` instead.
- Builds accepts `provider_type: "cloudflare_artifacts"` through raw JSON even
  though the beta's individual CLI enum omits it. The host Preview adapter uses
  the verified API request shape.
- Builds creation accepted `previews_enabled:true` but returned false. The host
  checks readback and migrates only its owned Worker. The equivalent command is
  `npx cf workers-builds workers migrate-to-previews <worker-tag> --deploy-command 'npx cf previews deploy'`.
- Main builds use `npx cf deploy`; branches use `npx cf previews deploy`.
  Do not deploy production build output with `--prebuilt` as a Preview.
- Beta.14 has no Preview-delete CLI command. The adapter uses
  `DELETE /accounts/{account}/workers/workers/{worker-name}/previews/{branch}`
  after checking ownership. No Wrangler exception was needed.
- Secret upload is `cf deploy --secrets-file` (verified above), or the separate
  `cf workers secrets bulk --file` API with its own JSON merge-patch schema.
  There is no `cf workers secrets put`. Bucket locks are a separate R2 API/CLI
  operation, not a property of the R2 binding configuration.

See [native toolchain evidence](evidence/phase-0.md),
[Builds evidence](evidence/cf-preview-builds.md), and the
[Cloudflare configuration documentation](https://developers.cloudflare.com/cf/projects/cloudflare-config/).


## Source deletion

The prepared administrator deletion API uses provider-read-only impact review,
exact typed repository confirmation and a durable source fence before cleanup.
It retains locked release/media bytes and audit history while removing mutable
repositories, previews, live work and grants. Imported systems additionally need
the portal consumer attachment barrier migration and its short-lived server
proof; a zero-consumer count alone is insufficient. See [the deletion protocol](lifecycle-deletion.md)
for routes, recovery and retained-byte semantics. No production source deletion
is part of the current implementation evidence.

### Authenticated MCP on a configured Studio domain

When the installation configures `TIMDS_STUDIO_ORIGIN`, its authenticated
`/api/timds/mcp` endpoint accepts that exact origin alongside `HOST_ORIGIN`.
The OAuth deployment must also enable that origin. Credentials remain scoped to
their issuing origin/resource; do not relabel an existing local session or
credential. Browser Origin checks still require the request's accepted origin,
and anonymous `/mcp` remains on the separate public host.
