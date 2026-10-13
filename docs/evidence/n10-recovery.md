# Original N10 publication recovery — 2026-10-13

The original batch `7fcba971-c7d9-4ed3-9d10-5b64f5ebd27a` finished on source
`6ffb48ea-862e-42de-9303-5edcbe8829d5`. All ten original Request, submission,
publication and Workflow instance identities are preserved. Provider and host
readback confirmed every publication `published`, every session `closed`, and
every submission `published`, with no remaining publication error. Immutable
versions are consecutive `2026.10.13-3` through `2026.10.13-12`; each source
commit's parent receipt matches its predecessor's published source commit.

The [sanitized receipt](n10-recovery.json) records all identities, Workflow
versions and successful stages, source commits, content digests, pointer events,
immutable public stamps and session cleanup. Current public readback at batch
completion was `.12`. Public MCP `get_tokens` returned all ten distinct
`--space-host69proof1` through `--space-host69proof10` tokens together. Current
may advance afterwards through the separately authorized manual publication;
the ten pinned versions remain immutable.

## Recovery used

The first two instances were already complete. The third resumed its original
staged release and completed without restart. Instances four through ten were
resumed one at a time only after their predecessor completed. Their old code
retained exhausted queue-contention preflight attempts, so each was paused,
observed paused with all attempts ended and queue readiness true, then restarted
once under its original instance ID. The new queue-readiness steps and newer
Workflow version IDs were read back. No publication row, source identity,
checkpoint, pointer or lease was reset, and no instance was recreated.

There was no direct SQL lease inspection available. The safety evidence was the
completed predecessor, paused provider with no live attempt, read-only binding
queue readiness, and the host's atomic claim recheck. This is not a claim of a
separate direct lease read. The paused later instances did not compete with the
one resumed head.

The tenth publication's durable close completed at `17:23:59.232Z`. Its provider
step remained running until an internal Workflow error at `17:28:38.815Z`;
the automatic retry succeeded at `17:28:38.937Z`. A fresh provider read confirmed
completion before the manual submission was admitted. No operator interruption
was used to clear this provider checkpoint delay.

## Interpretation

The original authoring receipts recorded zero conflicts, and successful merge
checkpoints retain the observed merged/conflicted keys. Persisted `conflictRate`
and `autoRebaseSuccess` remain null; no numerical rate was invented. Recorded
submit-to-publish durations include the deliberate stop, deployments, sequential
recovery and provider delays, so they are not a fresh performance benchmark.
This is live API/provider/public MCP evidence, not a new automated test suite.
The separate [MCP acceptance boundary](mcp-acceptance-boundary-2026-10-13.md)
records the fresh CIMD and full local editing-MCP flows not exercised here.
