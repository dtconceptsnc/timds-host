# Phase 1 production portal conformance

**The complete HTTP conformance suite passed on October 13, 2026.** This
satisfies issue #69's portal baseline gate. It does not establish conformance
of the new host, its `cf dev` runtime, CI deployment, or production migration.

The [machine receipt](phase-1-portal-conformance.json) is the unchanged redacted
output from run `a06ba833-0a4c-4e6b-a694-7fe1acc08bcf`:

| Item | Observed value |
| --- | --- |
| Target | `https://timds.com` |
| Started / finished (UTC) | `2026-10-13T09:46:26.823Z` / `2026-10-13T09:59:14.712Z` |
| Deployed portal revision | `e82dc8e45a02489269c27defd9f10eb9d6788921` |
| Vendored contract revision | `2b0148c70b363967ad0ea2eda092f7d0b442b93b` (same spec; the later commit changes documentation) |
| Exact toolkit client | `@dtconcepts/timds@0.1.464` |
| Harness recovery change | `d2ae3b0ca8bd710d42ee136d699d2b360b38c67d` |
| Source | `c3e83a28-052d-468a-8b76-958e1dbf75b4` |
| System | `timds/6e5e5b99-1bf7-4c62-b425-5bbaef408941` |
| Publications | `2026.10.13-4`, `2026.10.13-5`; queue positions `3`, `4` |
| Result | One complete live test passed; all six phases reached and completed |
| Cleanup | Eight tracked sessions closed; both publications drained as `published`; no unresolved publication attempts |

Receipt SHA-256:
`79d8ee933dd1949ee12c228712d414d17e3bfdc3218ffda5f34ef25e883f9257`.
Vendored OpenAPI SHA-256:
`4f9b4554a524ecb2b6796e2e3621adc11269b0158231e1b41dc70e5e60b93eb9`.

## Scope and assertions

The [dedicated fixture](phase-1-fixture.md) had no active sessions or unfinished
publications before the first run. The user approved a fresh isolated CLI
identity login. The normal authorization helpers granted that user publication
rights only on this fixture and created a distinct temporary member without
publication rights. Credentials were loaded into the test process environment;
no credential values are in this repository or the receipt. Existing customer
systems and the separate issue #60 acceptance resources were not modified.

The pinned toolkit supplied core HTTP operations; the validating transport
checked their real responses against the vendored OpenAPI. The run verified:

- Start, same-key recovery, pull, idempotent close and history retention.
- Named drafts, invitation and distinct member identity, overlapping advisory
  claims, shared CAS, stale base/hash rejection without mutation.
- Independent-key merge, exact base/mine/theirs conflict values, rejection of
  an obsolete resolution revision, and successful revision-bound resolution.
- Anonymous CSS GET/HEAD with `no-store`, correct token bytes and disappearance
  after draft closure; principal and human-intent audit history.
- Frozen submissions and actual HTML previews; publish dry run, two FIFO
  publications, consecutive dated versions, final session closure, anonymous
  current/pinned stamps, rollback dry run, actual rollback and restoration,
  and immutability of the newer pinned artifact.
- A real designer Request that created the exact requested file bytes,
  persisted a frozen submission with the original human instruction as its
  audit note, reused its execution identity on retry, did not publish or move
  the public pointer, and retained history after session cleanup.

The fresh run's two publication jobs both succeeded on their first attempts;
its `publicationRetries` list is empty. All jobs were picked up by the normal
production worker. No supplemental worker, forced job retry, schema change,
production service restart, or raw source/session state patch was used.

## Recovery observations and follow-up

The earlier run `ff86d088-7755-4193-b70a-45ce1bee83f7` failed under the harness's
original immediate-failure polling. Both publications had committed their
source/artifact/pointer before a public verification fetch failed. Normal
second attempts recovered from those stored pointer receipts, published, and
closed all seven sessions. The original run remains failed; it is not counted
as acceptance.

The harness was corrected to wait through retryable `failed`/errored `closing`
receipts while requiring final `published` status before the same deadline.
Observed failure states remain in redacted evidence. Unit tests prove transient
recovery, permanent failure timeout, and rejection of superseded or mismatched
publication identities. The 21-test unit suite passed. The fresh full run above
then passed without publication retry errors.

One portal execution-job bookkeeping issue was discovered separately from the
successful Request HTTP assertions. Request `fc5938c6-9e69-41e9-8787-6d12fff6f0f9` completed
and persisted its submission after its first live-runner forwarding request
reported a transport error. The harness observed and verified that durable
completion, then correctly closed its session. At `2026-10-13T10:01:22Z`, job
`2428231d-eb82-409e-9975-c2ecee56f2da` was still queued after a second attempt
rejected the closed session. It subsequently exhausted its three attempts;
no active fixture session remained.

The narrow receipt-recovery fix was merged in portal PR #78 and deployed as
`9dc40abf9c4b2e0bbff81d2684435b23f160557a`. At `10:21:11Z`, the original caller
repeated the normal Request POST with the same Request, prompt and closed
session. It returned the original execution-job ID. The normal production
worker recovered its matching frozen submission and succeeded on the first
new attempt. A project/type-scoped supplemental worker invocation at `10:24:06Z`
selected zero jobs because the normal worker had already taken the work. No
execution result, session, publication or source state was manually patched.

The [follow-up receipt](phase-1-cleanup.json) records the final public Request
read at `10:26:00Z`: `succeeded`, the original closed session, submission
`3b736be4-3299-42c7-a5f6-e8e6b84fab69`, and no error. All 15 sessions across both
runs remain closed; all four publications remain published.

The temporary member's only credential was revoked and its agent principal
deactivated at `10:24:53Z`, after checking its exact creation receipt, no other
credentials or publication grants, no owned sessions/jobs, and no invitations
outside the fixture. Its old credential returned HTTP 401, and the toolkit
removed the isolated local credential at `10:25:28Z`. Historical memberships
and audit rows were preserved. The approved owner's credential and fixture
publication grant remain available for the continuing host implementation.
