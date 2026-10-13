# Publication queue waiting and recovery

Each source admits one publication in its persisted FIFO order. Queue readiness
and the atomic job claim use the same SQLite checks: earlier blocking
publications, active attempt leases, and the job's scheduled availability.
Readiness is a binding-only read; it does not reconcile authority, mutate rows,
schedule alarms, or flush the outbox. The actual stage still claims a lease and
rechecks publication authority before changing source or release state.

A blocked Workflow records a successful readiness step and sleeps for 30
seconds. If readiness changes before the atomic claim, the stage records a
pending result and uses the same sleep path. Neither case consumes a stage's
failure retries or marks a queued publication failed. Real stage failures retain
their existing bounded retry and cleanup behavior. At most 720 sleeps are used
across a run (six hours of queue sleep); exhaustion ends that Workflow attempt
while retaining the original publication and receipts for explicit recovery.

This host uses Workers Paid for its native containers. Even if every readiness
check races with a claim, the bounded loop uses at most 1,454 counted steps and
stays below the explicitly configured 2,048-step limit. Cloudflare excludes durable sleeps from both the step limit and active
instance concurrency. See [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)
and the [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/).

## Existing instances from before this change

Do not assume a deployment migrates an existing Workflow instance. Cloudflare's
[restart documentation](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
describes canceling in-progress steps and resetting intermediate Workflow state;
the documented restart options choose a starting step, not a code version.
The host's publication rows, immutable artifact receipts, source commit receipts
and pointer event IDs remain independently durable in the coordinator and R2.

A read-only production observation on 2026-10-13 supports adoption of the new
version for one actual restart: original instance
`f38e6324-030a-4d02-aa26-6c24e0104fc6` reported Workflow version
`7ee73329-77b0-472d-a77a-c66cecc7e946`, created at `14:07:41Z` alongside Worker
deployment `04d8b165-67ab-463b-bac8-3b2739ec7471`. The instance was queued again
at `14:09:06Z`, started at `14:09:08Z`, and completed at `14:13:03Z`. Its original
publication had begun before that deployment. This proves the observed restart
used the newer Workflow version; it is not a general provider versioning
guarantee. See the [sanitized observation](evidence/workflow-restart-version.json).

For an old queue, capture the exact source, publication, submission, Workflow
instance status and version ID first. Recover only the earliest unfinished
publication after its predecessor is published (including successful cleanup)
and no active lease remains. Restart the same original instance once, then
observe its progress before proceeding to the next publication. A restart must
not interrupt a stage that is actively writing. If the instance retains old
code, this head-only recovery avoids its old FIFO retry loop because the source
is already available. Leave later instances alone while the head progresses.
After the first coordinated restart, read back its Workflow version ID and the
new `preflight:queue:0` step before treating the new wait behavior as deployed
for existing instances.

For a terminal Workflow, repeating the authorized publish request for the same
submission invokes the host's existing recovery path. An active old Workflow
that is only sleeping on queue contention requires coordinated operator
restart; an ordinary repeated publish request does not interrupt it. Never
replace publication IDs, clear coordinator rows, skip a predecessor, delete
Workflow state, or change a pointer to accelerate recovery. Verify the final
published row, cleared error, closed session, public stamp and immutable version
after recovery.

Local validation of the queue change: JavaScript syntax, `npm run typecheck`,
and a complete `npm run build` passed. No tests were added or run. Deployment
and actual recovery of the existing queue remain separately coordinated.
