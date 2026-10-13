# Agent multiplayer acceptance on the deployed host (2026-10-13)

Deployed host: `https://studio.timds.com`, Worker `timds-host-69`, version
`e785fb9c-e881-4e23-bfaf-44bc583d3786`, built from branch
`claude/hosted-timds-multiplayer-fc15de` at `f42c7c5`. Everything below ran
against the disposable source `6ffb48ea-862e-42de-9303-5edcbe8829d5`
(`timds/cf-preview-source-proof`); no production source was touched. Two tabs
of the Claude desktop built-in browser were used: tab A at desktop width with
a raw feed socket for timestamps, tab B emulated at 390 × 844. Both were signed
in as `demo@dtconcepts.net` through Access and the Studio PKCE flow. Raw
numbers are in [multiplayer-live-timing.json](multiplayer-live-timing.json).

## Phase 1: event log

- The coordinator numbered its 48 existing rows `seq` 1..48 in `created_at`
  order on first construction after the deploy; `GET .../events?after=0&limit=3`
  returned `latestSeq: 48, hasMore: true`.
- Creating draft `multiplayer-proof` wrote `draft_created` (49) and
  `member_joined` (50). Three Requests to the draft then wrote, in order:
  `request_received` ×3 (51–53), `member_joined` for the designer (54),
  `live_state waking` (55), `claimed` (56), `live_state starting` (57),
  `live_state running` (59), `request_started` (60), `request_submitted` and
  `submitted` in one commit (61–62), `live_state ready` (63). The target session
  already existed, so no `session_started` row was expected.
- Every row carried the designer principal, the session id and the Request id.

## Phase 2: feed

- `POST .../feed/tickets` returned a 60 s ticket and a `wss://studio.timds.com`
  URL; the upgrade replayed all 50 rows, sent `ready {after: 50}` and one
  `presence` frame. Without `Upgrade: websocket` the route answers 426.
- Delivery latency from coordinator commit to the raw socket in tab A: 14 to
  203 ms across eight samples (median 89 ms). Tab B's activity rail rendered the
  `request_received` row 13 ms after its commit. Gate (< 2 s): pass.
- Presence collapses duplicate principal/viewing pairs, so two tabs of one
  principal show one viewer; the indicator hides your own identity.

## Phase 3: agent presence and ordered Requests

- Three Requests sent to one draft within 5.5 s: the first ran, the second and
  third read `queued` with `queuePosition` 1 and 2; the draft row showed
  "2 queued" and the designer's advisory claim (`tokens.json, tokens/**, src/**`,
  later `tokens.json, tokens/space.json` from the previous submission's paths).
- They completed in order with three submissions (`7e6547c0`, `584ab71c`,
  `0ce07229`) and no error; each next Request started 9 to 13 s after the
  previous submission, after `live_state ready`.
- `active-work` and the session status carry `runner {state, requestId,
  submissionId, error}` and `queueLength` without starting a container.

## Phase 4: Studio steering console

- No editor, file viewer or claim form exists; Studio refuses to call
  `update`, `submit` or `claims`.
- The draft page embeds the live Worker (`sandbox="allow-scripts
  allow-same-origin allow-forms"`, `referrerpolicy="no-referrer"`) with the
  state strip reading `starting` during the cold start, then `running` and
  `ready`; the live Worker answers with
  `content-security-policy: frame-ancestors https://studio.timds.com` and no
  `X-Frame-Options`. Studio's own CSP carries
  `frame-src https://*.timds.workers.dev` and `connect-src 'self'
  wss://studio.timds.com`.
- The phone composer sent a Request targeting the draft; its row showed
  `RUNNING` with the runner strip and the target name, and the activity rail
  updated live. The Review tab showed the four submissions with changed-file
  paths and rendered submission `0ce07229`'s Preview inline; Preview Workers
  answer 200 with no frame-blocking headers.
- Phone layout at 390 × 844: one column, `scrollWidth` 390 (no horizontal
  scroll), frame 328 × 464; the only controls under 44 px tall are the
  pre-existing header source select, Refresh and Disconnect.

## Phase 5: warm drafts and visible wake

- Cold start of the new draft: `request_received` 20:05:58.65 →
  `live_state waking` 20:06:01.82 (+3.2 s) → `starting` 20:06:03.33 →
  `running` 20:08:30.34 (+151.7 s) → `ready` 20:09:16.77 (+198.1 s). Reported,
  not gated. The Studio client shows `waking` on send, before the event.
- Wake of a sleeping session by a plain fetch of its live URL (no Request):
  `starting` 20:08:04.08 → `ready` 20:09:28.74 (84.7 s).
- Warm reload after a push: tab B's frame fired `load` 3.8 s and 3.5 s after
  the `request_submitted` commits (gate < 5 s): pass.
- Watched-draft idle and unwatched-sleep checks: see the JSON receipt
  (`watchedIdle`, `unwatchedSleep`).

## Director journey with a second human (staff@dtconcepts.net, from a phone)

- Presence: `staff` viewing session `fa39907d` appeared on `demo`'s feed socket
  while `demo`'s own two tabs collapsed into one viewer entry.
- Publish from the phone of submission `67be2270` (session `fa39907d`,
  `multiplayerProof4 = 42px`): `publication_queued` 20:21:32.7, stages
  preflight 20:21:36.0, merge 20:21:37.2, build 20:22:30.8, prepare 20:23:54.0,
  release 20:24:00.5, flip 20:25:03.1, `published` 20:25:04.6, close 20:25:05.9,
  then the session closed at 20:25:19.8. Tab B's stage strip tracked each
  stage as its event arrived (3.5 minutes end to end).
- Conflict: a follow-up Request in the draft (which held 41px) ended with
  `updated` and `request_failed: conflicted` at 20:26:39.97 and the runner
  reported two conflicts on `tokens/space.json` (`multiplayerProof4.value` 41px
  vs 42px and its description). The draft page rendered the read-only receipt
  and one "Ask the agent to resolve" button; no mine-or-theirs chooser.
- Resolution: the first resolve taps conflicted again because the runtime
  submitted without a resolution. Commit `a1a9063` fixed the runtime (it
  submits `resolvedPaths` for the conflicted keys against the `mainRevision`
  the conflict was seen on, resubmitting once if needed). After redeploying
  (Worker version `c32b6033`), `staff`'s tap at 20:36:34 produced one
  conflicted attempt at 20:37:58 and then submission `2accd79d` at 20:38:21;
  Studio showed the Request as SUCCEEDED with the conflict block gone.
- History now names two humans (`demo`, `staff`) and the designer agent.

## Not executed in this run

- Rollback and restore from the phone (deferred by the user to a later run).
- A third human principal and a third browser: two human identities were
  available (`demo` on two tabs, `staff` on a phone).
- The watched-draft 30-minute idle check is recorded as far as it ran in the
  JSON receipt; the feed-only watcher was dropped by the redeploy at 20:36, so
  the remaining observation relies on the Studio tab watching the draft.
