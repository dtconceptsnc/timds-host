# Issue 69 follow-up stopping point

Paused at the user's request to PR the current work and resume later. Do not
mark the last provider-URL checkbox complete or close toperator issue #69 yet.

Completed: obsolete DNS removal; user-confirmed VM decommissioning; local editing
MCP mutation/publication/replay; fresh Studio CIMD authorization/read/revocation;
remote gap write/replay. These have separate receipts in the host and portal PRs.

## Production provider URLs

The [progress receipt](provider-url-progress-2026-10-13.json) records two completed
native releases, both with published source `provider.url` set to
`https://studio.timds.com`:

- Speed.Style: `2026.10.13-1`, source commit
  `be1742141cc9f1802c5400c943509c7b055a6ece`.
- WPL: `2026.10.13-1`, source commit
  `e60450d01c61d4c7c8c9f299ab277d4ccd914cf8`.

Their sessions are closed, production Builds succeeded, immutable public tokens
returned 200, and all 23 earlier release identities are unchanged. Consumer pins
were not edited. The final 36-release/token comparison remains pending Pierce.

Imported preview tooling invoked Wrangler. Reviewed changes migrated the three
source workspaces to pinned CF CLI preview/deploy commands and static asset
packaging, preserving the source framework, locked TimDS version, design content,
media, public domains and other Builds connection settings. Local packaging was
byte-identical for 87 Speed.Style, 301 WPL and 702 Pierce assets. WPL media/video
and Pierce video checks passed. WPL and Pierce use an Astro completion hook;
Pierce retains its non-root artifact entry.

Pierce's original reviewed submission remains the resume target:

- Source: `f7cfb345-391a-40ba-80f4-fc08359696bb`
- Session: `3bda4490-3702-44fc-aee0-8b743e342f91`
- Submission: `c2b068f0-292e-4de5-acb9-b3cee93c6160`
- Reviewed head: `b1995e3aaa634915f7a8397866495d5dd8a1eb87`
- Publication/Workflow: `b7ec0b7c-2cbd-48c5-922f-eef88d4ff8ee`

The post-transfer-fix dry run passed in 9m25s with clean currency and build checks.
The planned version was `2026.10.13-2`; the live release remains `2026.10.13-1`.
The publication failed at Workflow preflight before merge/build/release. A
separate host deployment appeared during the request, and the user confirmed
another deployment was running. Its causal role in the failure is not established.
Do not overwrite that deployment or replace the existing session/submission.

## Resume

1. Confirm the other host deployment has finished and inspect its current code,
   configuration and the existing publication's failure. The newer publication
   feed code adds `recordPublicationStage`; the failed Workflow's public error
   does not identify the precise failed check.
2. Resolve that failure and resume the same publication through the normal
   authenticated toolkit publish flow with the explicit submission above.
3. Verify the actual new release, its source manifest, closed session, production
   Build and immutable public tokens. Do not claim the dry-run version was published.
4. Compare all 36 historical release identities and token responses with the
   saved baseline (27 successful reads and nine pre-existing 404s), then finish
   the docs/receipts, last checkbox and issue closure.

Local acceptance workspaces, operation files, comparison baseline and helper
scripts remain under `/tmp/timds69-followups`. They are private temporary working
files, not durable credentials or a deployment entry point. The finalization
scripts there assume all three publications succeeded; do not run them early.

The bounded-transfer fix and Studio MCP correction are committed in host PR #2.
Portal PR #94 records DNS, VM attestation and deployed acceptance status. The
separate earlier failed disposable MCP session remains `closing` after a fork
identity rejection; its cleanup receipt is explicit and separate from the
successfully published acceptance session.
