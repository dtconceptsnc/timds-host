# Concurrent designer Requests

`scripts/run-designer-batch.mjs` is an operational client that creates real
Requests and optionally publishes their submitted changes. It is not a test
runner. Use a disposable system for acceptance work: each Request starts a real
model session and can incur provider charges.

Sign into the selected host with the released OAuth-capable TimDS CLI. The
script reads that same private credential store and uses the caller's existing
source and publisher grants. It never grants permissions or prints credentials.
The first run binds the plan to that host human principal; a different signed-in
identity cannot resume it. Unset `TIMDS_ACCESS_TOKEN` so an ambient bearer cannot
override the host-bound OAuth credential store.

Write a bounded prompt in a private text file. `{{index}}` is replaced with each
Request's one-based number. Choose independent file paths or JSON keys and state
the exact requested edit, constraints, and intent. Ask each designer to submit
for review without publishing. The operator script can later publish those
submissions with the human's grant.

```sh
node scripts/run-designer-batch.mjs plan \
  --host https://your-host.example --source-id '<source-uuid>' \
  --count 10 --prompt-file /private/batch-prompt.txt \
  --state /private/batch.json

# Review the saved prompts and target. This creates the real Requests.
node scripts/run-designer-batch.mjs run --state /private/batch.json \
  --credentials /private/timds-credentials.json --yes

# After reviewing the submissions, queue their publications in saved order.
node scripts/run-designer-batch.mjs run --state /private/batch.json \
  --credentials /private/timds-credentials.json --yes --publish
```

All Requests are dispatched before the runner waits for designer completion.
Publication waits until every Request has a submission, then queues the saved
submission order without waiting for individual builds. The host coordinator
owns FIFO execution. Output includes submitted/published counts, reported
conflicts, publication stages, and the actual resulting version list. A failed
or incomplete batch is not a successful zero-conflict acceptance result.

The owner-only state file is required for resume. It contains prompts and stable
Request/publication IDs, so keep it outside Git and preserve it after an
interrupted response. Re-run the same command; no new IDs are invented. Failed
Requests and publications require review in Studio and are not silently retried.
Every resume rereads known publication receipts, including previously failed or
published rows, so manual Studio recovery is reflected without another POST.
`superseded` is a terminal review outcome. Once `--publish` is explicitly saved
for this batch, later resumes preserve that authorization even without the flag.
`status --state /private/batch.json` reads the local receipt without network
access. Each invocation defaults to a one-hour wait; `--timeout-minutes` accepts
1–240. Stopping the client does not cancel server-side work.

A sibling `.lock` records the active client PID. Normal completion and handled
interrupts remove it. After a crash, confirm that process is stopped before
removing only the stale lock; retain the state file. Do not run concurrent
clients against the same state file. Use a fresh plan only for new intentional
work, never to recover an uncertain response.
