# `cf` inside Workers Builds

This disposable static-site fixture proved pinned `cf@1.0.0-beta.14` for both
production and branch Preview deployments from an Artifacts repository. Both
real push-triggered builds emitted `cf.workersBuilds.worker.build.succeeded`.
See [sanitized receipt](./receipt.json) and evidence (private operational record).
Every remote resource from the recorded run has been deleted; its URLs now 404.

The tested commands are `npm run build`, then `npx cf deploy` for `main`, and
`npm run build`, then `npx cf previews deploy` for other branches. The second
command builds again with the correct Preview context. Do not replace it with
`--prebuilt` after an ordinary production `cf build`.

## Repeat in an isolated checkout

Copy this directory into a fresh temporary directory, install with `npm ci`,
and initialize its own Git repository on `main`. Keep credentials outside the
checkout. Use an existing Cloudflare credential with Workers, Artifacts and
Queues permissions for resource commands, plus an existing Builds-capable
credential/login for Builds commands. A registered Builds deployment token is
required; the probe never creates, modifies, or deletes one.

Set nonsecret `CLOUDFLARE_ACCOUNT_ID`, a fresh
`TIMDS_SPIKE_NAME=timds-host-preview-spike-<unique-suffix>` (suffix max 20 chars),
and `TIMDS_SPIKE_ACK` to the exact same name. Replace the example Worker name in
`cloudflare.config.ts` with that name before committing. Both branches must use
that same Worker name. The static markers below must differ between branches.

```sh
npm ci
node scripts/artifacts.mjs create
npm run deploy
```

The helper captures the credential-bearing repository creation response, stores
only repository identity in ignored `.spike-state.json`, and revokes the initial
capability. Each Git push gets a 120-second write capability, holds it only in
memory/the Git child environment, and revokes it in `finally`.

Read the new Worker's `tag` from `cf workers list` and set
`TIMDS_SPIKE_WORKER_TAG`. Read the intended existing deployment credential's
`build_token_uuid` from `cf builds tokens list` and set
`TIMDS_SPIKE_BUILD_TOKEN_UUID`. Neither identifier is a credential value.

```sh
node scripts/build-config.mjs
npx cf builds workers create --body "$(cat .spike-build-config.json)"
npx cf builds workers get "$TIMDS_SPIKE_WORKER_TAG"
```

Use the intended Builds login/token for those commands. In the recorded run,
the saved `cf` OAuth supported Builds, while the separately loaded broad OAuth
supported Artifacts/Queues and returned 403 on Builds. No persistent credential
was minted. Do not accidentally override the Builds login with an unrelated
`CLOUDFLARE_API_TOKEN`.

The raw `--body` is needed because the individual provider flag's enum omits
`cloudflare_artifacts`, although the API accepts it. Read back the created
configuration. On beta.14 the create request accepted `previews_enabled:true`
but returned `false` and created a legacy nonproduction trigger. If readback is
false, run this **only on the disposable Worker just created**:

```sh
npx cf workers-builds workers migrate-to-previews "$TIMDS_SPIKE_WORKER_TAG" \
  --deploy-command 'npx cf previews deploy'
npx cf builds workers get "$TIMDS_SPIKE_WORKER_TAG"
```

Require `previews_enabled:true`. A direct PATCH to true failed with code 12048
because the legacy trigger existed. Migration succeeded with the `cf` command.
The migration changes the preview model; never run it on an unrelated Worker.

Before pushing, create a uniquely named Queue and HTTP pull consumer:

```sh
npx cf queues create --queue-name "$TIMDS_SPIKE_NAME"
# Set TIMDS_SPIKE_QUEUE_ID to the returned queue_id.
npx cf queues consumers create "$TIMDS_SPIKE_QUEUE_ID" \
  --type http_pull --settings-visibility-timeout-ms 30000
npx cf queues subscriptions create \
  --name "$TIMDS_SPIKE_NAME" --enabled \
  --source-type workersBuilds.worker --source-worker-name "$TIMDS_SPIKE_NAME" \
  --events build.succeeded build.failed \
  --destination-type queues.queue --destination-queue-id "$TIMDS_SPIKE_QUEUE_ID"
```

Record the returned consumer and subscription IDs. Subscribe to this exact
Worker, never to unrelated account events. Commit only the fixture source and
lockfile, then push main and the branch:

```sh
git init -b main
git add .gitignore package.json package-lock.json cloudflare.config.ts vite.config.ts index.html scripts
git commit -m 'Prove pinned cf static site through Workers Builds'
node scripts/artifacts.mjs push main
git switch -c review-cf-proof
# Change only index.html's main-marker text to preview-marker.
git add index.html
git commit -m 'Prove cf branch Preview through Workers Builds'
node scripts/artifacts.mjs push review-cf-proof
```

Do not paste repository-token command output. The helper performs token work
without exposing values. The static-site code has no secrets or bindings.

## Verify the real builds and events

```sh
npx cf builds list --external-script-id "$TIMDS_SPIKE_WORKER_TAG"
npx cf workers-builds workers previews list --script-tag "$TIMDS_SPIKE_WORKER_TAG"
# Set TIMDS_SPIKE_PREVIEW_ID from the review-cf-proof row.
npx cf workers-builds workers previews list-builds "$TIMDS_SPIKE_PREVIEW_ID" \
  --script-tag "$TIMDS_SPIKE_WORKER_TAG"
npx cf queues messages pull "$TIMDS_SPIKE_QUEUE_ID" --batch-size 10
```

`cf builds list` on the parent returns production builds; inspect the branch's
Preview build list separately. Require successful outcomes for the exact two
Git commit hashes, not simply the latest successful record. Inspect their logs
with `cf builds logs get <build-uuid>` to verify the exact deploy commands. The
Preview command prints both branch and immutable deployment URLs as JSON.

Require the main URL to return only `main-marker`, and both Preview URLs to
return only `preview-marker`, anonymously with HTTP 200 and `text/html`.
Require two queue events of type `cf.workersBuilds.worker.build.succeeded`, with
matching Worker, build UUID, branch, commit hash and deploy command. The actual
payload uses `status:"stopped"` and `buildOutcome:"success"`. It has no URL;
read the Preview/deployment metadata or cf deployment output for those URLs.
Pull message bodies were JSON strings, not base64. Queue delivery can repeat.

## Remove only the recorded resources

First read the owned Worker's triggers and verify repository name, namespace,
and repository ID match `.spike-state.json`. Record `repo_connection_uuid`.
Check it is not used by another Worker before removing it.

```sh
npx cf builds triggers list --external-script-id "$TIMDS_SPIKE_WORKER_TAG"
npx cf builds repos connections delete "$TIMDS_SPIKE_CONNECTION_ID" --force
npx cf builds workers delete "$TIMDS_SPIKE_WORKER_TAG" --force
npx cf queues subscriptions delete "$TIMDS_SPIKE_SUBSCRIPTION_ID" --force
```

`cf` beta.14 does not expose a Preview-delete command. The verified direct API
operation is `DELETE /accounts/{account}/workers/workers/{worker-name}/previews/review-cf-proof`
with the existing Workers credential. This deletes only the named Preview.
Use the authenticated API client without printing its Authorization header.
No Wrangler execution is required.

```sh
npx cf workers delete "$TIMDS_SPIKE_NAME" --force
npx cf artifacts namespaces repos delete static-site --namespace "$TIMDS_SPIKE_NAME" --force
npx cf artifacts namespaces delete "$TIMDS_SPIKE_NAME" --force
npx cf queues consumers delete "$TIMDS_SPIKE_CONSUMER_ID" --queue-id "$TIMDS_SPIKE_QUEUE_ID" --force
npx cf queues delete "$TIMDS_SPIKE_QUEUE_ID" --force
```

Verify the Worker is absent and main, branch, and immutable URLs return 404.
Keep the existing shared deployment token registered. The packaged helpers
were syntax-checked and the source built locally; the live receipt comes from
the equivalent standalone fixture and commands documented above.
