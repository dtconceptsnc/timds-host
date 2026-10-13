# N10 publication stopping point — 2026-10-13

Historical snapshot. The original ten publications have since completed; see
the [recovery result and final receipts](n10-recovery.md). The state below is
preserved as the original pause record.

The local batch watcher was stopped before pausing cloud work. The exact ten
publication IDs came from the preserved batch state for batch
`7fcba971-c7d9-4ed3-9d10-5b64f5ebd27a`, source
`6ffb48ea-862e-42de-9303-5edcbe8829d5`. Each Cloudflare instance's stored payload
was checked against that source and publication ID before any pause request.

The two completed instances were left unchanged. Pause was requested for all
eight unfinished instances using the normal status API. Seven paused promptly;
`68b84f4a-ab1a-4bec-9adc-7409e96cce75` first reported `waitingForPause`, then
finished its release step at `15:01:47.147Z` and paused before the flip step.
Its staged source/release work is retained. Final provider readback at
`15:03:20Z` confirmed **two complete and eight paused**. No instance was
terminated, deleted, recreated or restarted. No deployment or production
ownership transfer occurred.

The [sanitized before/after receipt](n10-workflow-pause.json) contains the exact
Request, submission and publication IDs, Workflow versions, API pause responses
and final statuses. The original local batch state remains at
`/tmp/timds69-host-acceptance/designer-batch.json`; do not overwrite it with a new
batch or regenerate its identities.

## Resume deliberately

Use the same authorized Cloudflare account and Workflow
`timds-host-69-publication`. First inspect the saved IDs and current host
publication receipts; the receipt is a stopping-point snapshot, not a guarantee
of future state. Resume the earliest paused publication first, then observe its
publication/cleanup result before resuming later instances. In the pinned
`cf@1.0.0-beta.14` CLI, pass the action explicitly:

```sh
npx cf workflows instances get '<publication-id>' --workflow-name timds-host-69-publication --simple true
npx cf workflows instances resume '<publication-id>' --workflow-name timds-host-69-publication --status resume
```

The underlying endpoint is
`PATCH /accounts/{account_id}/workflows/{workflow_name}/instances/{instance_id}/status`
with JSON body `{"status":"resume"}`. Pausing used the same endpoint with
`{"status":"pause"}`. Supply credentials through the existing private CLI
profile or environment, never command literals or this receipt. These are
resumable operations; do not substitute terminate, restart or delete. See the
[Cloudflare status API](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/subresources/status/methods/edit/)
and [pause/resume documentation](https://developers.cloudflare.com/workflows/build/trigger-workflows/).

The FIFO fix is committed but was not deployed at this stopping point. Its
configuration now explicitly allows 2,048 counted steps, sufficient for the
bounded readiness loop; the prior 32-step limit was unsuitable for that loop.
Any later migration to the new Workflow code must follow the separate
[queue recovery plan](../publication-queue-recovery.md), with explicit code
version and step verification. Ordinary resume preserves the current Workflow
checkpoint and must not be described as a code upgrade.
