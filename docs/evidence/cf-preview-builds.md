# `cf` production and Preview commands inside Workers Builds

Status: **passed live on 2026-10-13 UTC; all disposable resources removed**.
This resolves the Workers Builds execution unknown left by the first
[Phase 0 spike](./phase-0.md). It does not satisfy the separate production portal
conformance gate or authorize starting host domain implementation before that
gate passes.

## Tested path and outcome

A separate Artifacts namespace `timds-host-preview-spike-69-4c8f`, repository
`static-site`, and same-named static-site Worker were created. No conformance
fixture, production portal, designer, or issue #60 resource was changed.
The fixture used `cloudflare.config.ts`, the Cloudflare Vite plugin, one static
`index.html`, and a committed npm lockfile. No Wrangler dependency or command
was used in either build.

Pinned dependencies:

- `cf`: `1.0.0-beta.14`
- `@cloudflare/vite-plugin`: `2.0.0-beta.sha-91c870c02`
- `vite`: `8.3.4`

Both actual Git pushes, not manual local deploys alone, completed successfully:

| Branch | Commit | Build UUID | Build/deploy commands |
| --- | --- | --- | --- |
| `main` | `322482704b5c213b19dcd7b444a266af43eeeb22` | `32fee9a6-5b0d-4011-b150-99151d2069ac` | `npm run build`; `npx cf deploy` |
| `review-cf-proof` | `333b674cfdcaeac44de00a3c3477d89ffd2c3fb9` | `4a2f3e59-f75a-4872-932f-adcbfb68f65c` | `npm run build`; `npx cf previews deploy` |

The production deployment version was `e857048c-91a0-4f04-bb41-109d7f7ab11a`.
The Preview ID was `2ba8d3da342f4c7c97b831b74ce44668`.
Both build records had `status: "stopped"`, `build_outcome: "success"`; logs
confirmed execution of the configured commands and successful completion.

Anonymous Node `fetch` verified `200 text/html` and distinct exact markers:

- `https://timds-host-preview-spike-69-4c8f.ratebucket.workers.dev`
  contained `main-69-4c8f` and not the Preview marker.
- `https://review-cf-proof-timds-host-preview-spike-69-4c8f.ratebucket.workers.dev`
  contained `preview-69-4c8f` and not the main marker.
- `https://08b7a0c3-timds-host-preview-spike-69-4c8f.ratebucket.workers.dev`
  was the immutable deployment URL and contained the same Preview marker.

These URLs are intentionally no longer live. All returned 404 after cleanup.
See [machine-readable sanitized receipt](../../spikes/cf-preview-builds/receipt.json).

## Exact setup behavior and limitations

The tested repository connection body used
`git_repository.provider_type: "cloudflare_artifacts"`, namespace for both
provider-account fields, the Artifacts repository ID, `branch: "main"`, and
separate production/Preview settings. `cf builds workers create --body <json>`
accepted this provider. The individual `--git-repository-provider-type` flag's
enum did not list Artifacts, so raw JSON was required.

Creation accepted `previews_enabled: true` but returned **false** and created a
legacy nonproduction trigger. A subsequent PATCH enabling Previews failed with
HTTP 400/code 12048: the legacy trigger must be migrated. This exact command
worked on the newly created disposable Worker:

```sh
cf workers-builds workers migrate-to-previews <worker-tag> \
  --deploy-command 'npx cf previews deploy'
```

Readback then reported `previews_enabled: true`. Do not infer readiness from
an accepted create response; verify the returned configuration. Migration was
confined to the disposable source. It is unnecessary when creation/readback
already returns true, and must not be applied to an unrelated existing Worker.

`cf previews deploy` inferred the branch name inside Workers Builds. An ordinary
`npm run build` produced production Build Output first; the deploy command built
again with the Preview context. Using `--prebuilt` on that production output
would be incorrect. `cf builds list --external-script-id <parent-tag>` returned
production builds; the Preview build required the separate
`cf workers-builds workers previews list-builds <preview-id> --script-tag <parent-tag>`
command.

`cf` beta.14 has no exposed Preview-delete command. Cleanup used the verified
Workers API operation:

```text
DELETE /accounts/{account}/workers/workers/{worker-name}/previews/{preview-name}
```

That request succeeded, and the Preview URLs subsequently returned 404. This is
a direct API exception, not a required Wrangler command. The other creation,
Builds configuration, deployment, and resource deletion commands have `cf`
equivalents. No production configuration was switched.

## Actual event receipt

A unique Queue and HTTP pull consumer subscribed to the exact Worker source:

```json
{
  "source": { "type": "workersBuilds.worker", "worker_name": "timds-host-preview-spike-69-4c8f" },
  "events": ["build.succeeded", "build.failed"],
  "destination": { "type": "queues.queue", "queue_id": "<disposable-queue-id>" },
  "enabled": true
}
```

Both succeeded events arrived. These are the exact relevant fields of the
received Preview event; timestamps, account metadata, and author text are
omitted from this sanitized projection:

```json
{
  "type": "cf.workersBuilds.worker.build.succeeded",
  "source": {
    "workerName": "timds-host-preview-spike-69-4c8f",
    "type": "workersBuilds.worker"
  },
  "payload": {
    "buildUuid": "4a2f3e59-f75a-4872-932f-adcbfb68f65c",
    "status": "stopped",
    "buildOutcome": "success",
    "buildTriggerMetadata": {
      "branch": "review-cf-proof",
      "commitHash": "333b674cfdcaeac44de00a3c3477d89ffd2c3fb9",
      "buildCommand": "npm run build",
      "deployCommand": "npx cf previews deploy"
    }
  }
}
```

The actual `status` is `stopped`, unlike the documentation example's `success`.
Use event type, successful outcome, Worker identity, branch, commit hash and
build UUID together. The event payload contained no Preview/deployment URL.
Its keys were `buildUuid`, `status`, `buildOutcome`, `createdAt`, `initializingAt`,
`runningAt`, `stoppedAt`, and `buildTriggerMetadata`. Read Preview/deployment
metadata or the deployment output for URLs. HTTP pull returned the message body
as a JSON string; it did not need base64 decoding. Handle duplicate delivery.

## Credentials and cleanup

The existing saved `cf` OAuth could access Builds. The existing broader OAuth
used by the first Phase 0 spike could access Workers/Artifacts/Queues but got
403/code 10000 on Builds. Commands used the appropriate existing authentication
context; no new persistent API credential was minted. The Builds connection
referenced the already registered TimDS deployment credential by UUID only.
That shared credential was retained unchanged.

The initial disposable repository capability was revoked, as were the
short-lived push capabilities. Cleanup removed the owned Builds repository
connection and configuration, named Preview and Worker, event subscription,
Artifacts repository and namespace, pull consumer, and Queue. The Worker was
absent from the account list; all three URLs returned 404. Only local source,
package caches, and sanitized proof files remain.

## Reproduction and scope

[Standalone fixture and commands](../../spikes/cf-preview-builds/README.md)
include the minimal static site, exact pinned lockfile, safe capability helpers,
Builds request generator, migration step, verification requirements, and scoped
cleanup. The packaged helpers were syntax-checked, and the packaged fixture
built successfully. The live receipt came from the equivalent standalone source
in the disposable Artifacts repository; packaging adds only safe setup helpers
and an example resource name.

This proves the requested cf/Builds tooling path for static Viewer previews.
It does not prove Container-backed Previews or the future host's entire Viewer
pipeline. `cf` currently documents a Container Preview limitation; the host
should keep Viewer static assets separate from its container-backed runtime.

Official references checked during the spike:

- [Cloudflare CLI projects and Preview command](https://developers.cloudflare.com/cf/projects/)
- [Workers Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)
- [Workers Builds event subscriptions](https://developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions/)
- [Queue event schemas](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/)
