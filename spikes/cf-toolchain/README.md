# cf toolchain proof

This isolated Phase 0 spike proves a container-backed SQLite Durable Object,
credential-isolated Git clone/commit/push against Artifacts, D1, R2 and a Queue.
It contains no TimDS host implementation. See the dated receipts (private operational record).

Pin `cf@1.0.0-beta.14` and use `cloudflare.config.ts`. No Wrangler binary or
package is required. Node 22.18+ and a running Docker engine are required. Use a
Workers Paid account with Containers and Artifacts enabled. Authenticate with
`cf auth login`, or supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to
commands. The credential needs Workers scripts, Containers, D1, R2, Queues and
Artifacts write access. A Workers/Builds-only login cannot provision the other
products. Do not place credentials in this directory's tracked files.

## Run

Choose a unique disposable suffix and retain it in every shell used for the spike:

```sh
export TIMDS_SPIKE_NAME="timds-host-spike-your-unique-suffix"
npm ci
npm run setup-token
npx cf d1 create --name "$TIMDS_SPIKE_NAME"
npx cf r2 buckets create --name "$TIMDS_SPIKE_NAME"
npx cf queues create --queue-name "$TIMDS_SPIKE_NAME"
npx cf artifacts namespaces create --namespace "$TIMDS_SPIKE_NAME"
npx cf containers build . --tag "$TIMDS_SPIKE_NAME"
npx cf containers push --tag "$TIMDS_SPIKE_NAME"
npm run typecheck
npm run build
npx cf deploy --dry-run
npm run deploy
```

Record the IDs and Worker URL returned by these commands for cleanup. The
configuration resolves resources by the same disposable name. The deploy builds
and pushes the Docker image automatically; explicit build/push above proves
those two CLI operations independently. Secrets are uploaded with
`cf deploy --secrets-file .dev.vars`; the generated ignored file has mode 0600.

Exercise the deployed URL printed by deploy:

```sh
npm run probe -- https://YOUR-DISPOSABLE-WORKER.workers.dev
```

Run the local server, then invoke the local probe from a second shell in this
directory with the same `TIMDS_SPIKE_NAME`:

```sh
npm run dev
npm run probe -- http://127.0.0.1:8796
```

The probe prints a commit ID, matching R2 bytes, D1 `healthy: 1`, queue `sent`,
and `artifacts: cloned and pushed`. Its POST endpoint requires the generated
secret; `/health` is public. It creates one disposable `probe-<uuid>` repo per
run and retains it for inspection. Git credentials stay in the Worker outbound
proxy and are revoked after execution. The container runs with Internet disabled.

## Beta limitations

- `cf dev --local` is rejected by beta.14. `cf dev` is the local Vite/runtime loop.
- Artifacts has no local simulator. This sample explicitly sets
  `dev: {remote: true}` on the Artifacts binding. Local runs use the disposable
  remote namespace and local D1, R2, Queue and Docker. A fully offline conformance
  suite needs an explicit test adapter, and is not a native Artifacts proof.
- A same-Worker `bindings.durableObject({worker:name,exportName})` is incorrectly
  rejected by cf's Container deploy validator as an external DO. The working
  configuration declares the DO export and calls `ctx.exports.RepositorySandbox`.
- DO `worker.exports` declarations replace ordered migrations for new classes.
- Use `cf r2 buckets create` (plural), `cf queues create --queue-name`, and
  `cf artifacts namespaces create --namespace`.
- No required Wrangler exception was found. Optional live tail has no cf
  equivalent yet. Secret updates use `cf workers secrets bulk --file` or a
  version upload with `--secrets-file`; there is no `cf workers secrets put`.
- `cf previews deploy` exists. This spike does not establish its behavior inside
  a Workers Builds trigger; that is a separate acceptance requirement.
- Remote Artifacts development may not preserve custom Error `.code` fields.
  This probe uses a fresh repo name instead of relying on duplicate-create error
  metadata. The production adapter must normalize the observed error shapes.

## Cleanup

Stop the local dev process. Restrict cleanup to the exact disposable name and
IDs returned above. CLI delete identifiers are positional. Inspect the relevant
command help before use. Delete the Queue consumer first, then the Worker, then
Queue: either reverse order is rejected while references remain.

```sh
npx cf queues consumers list --queue-id YOUR_QUEUE_ID
npx cf queues consumers delete YOUR_CONSUMER_ID --queue-id YOUR_QUEUE_ID --force
npx cf workers delete "$TIMDS_SPIKE_NAME" --force
npx cf queues delete YOUR_QUEUE_ID --force
npx cf containers applications list
npx cf containers applications delete YOUR_DISPOSABLE_APPLICATION_ID --force
npx cf artifacts namespaces repos list --namespace "$TIMDS_SPIKE_NAME"
# Repeat for every probe-<uuid> repo shown in this disposable namespace.
npx cf artifacts namespaces repos delete YOUR_PROBE_REPO --namespace "$TIMDS_SPIKE_NAME" --force
npx cf artifacts namespaces delete "$TIMDS_SPIKE_NAME" --force
npx cf r2 objects delete probe.txt --bucket-name "$TIMDS_SPIKE_NAME" --force
npx cf r2 buckets delete "$TIMDS_SPIKE_NAME" --force
npx cf d1 delete YOUR_DATABASE_ID --force
npx cf containers images delete "$TIMDS_SPIKE_NAME:latest" --force
```

Also delete the exact `cloudflare-build/...` image tag printed during deploy
with `cf containers images delete IMAGE:TAG --force`. Container shutdown may
finish asynchronously. Keep the local source and receipt; remove `.dev.vars`
when this disposable exercise is finished.
