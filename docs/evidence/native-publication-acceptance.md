# Native publication acceptance, 2026-10-13

This records actual use of the deployed host and released toolkit 0.1.471.
No new automated tests were written or run for this work.

- Host: `timds-host-69.ratebucket.workers.dev`, deployment `a8107924`.
- Disposable source: `6ffb48ea-862e-42de-9303-5edcbe8829d5`,
  `timds/cf-preview-source-proof`.
- Submission: `189cf3bd-5082-4c9e-8a47-f74094139f83`.
- The complete dry run returned 200 with `buildChecked:true`, clean currency,
  and version `2026.10.13-2`; see the separate dry-run receipt.
- Real publication: `f38e6324-030a-4d02-aa26-6c24e0104fc6`, queued at
  13:44:53 UTC, advanced through merge/build/prepare/release and committed its
  pointer before 13:49 UTC.
- Anonymous current stamp returned 200 with version `2026.10.13-2`, source commit
  `0c1a05238acf4a91667c1460606eef0890031c98`, content digest
  `804731bc26f0b4044fc4f02c88336890b3a93182d0b53566551aa6955fadf0a0`.
- The actual published spacing page returned 200 and displayed the authored
  `motion.fast = 170ms`. This is a token value, not an operation latency.
- A real MCP client connected to the public `/mcp`, listed the three deployed
  read tools, described that release, read `--motion-fast` as `170ms`, and read
  page ID `web/spacing` as Markdown containing `170ms`. Supplying the trailing
  slash URL `/web/spacing/` instead of the listed page ID returned a page-not-found
  error; the explicit page ID succeeded.

The operation is **not yet accepted as complete**. Its close stage failed:
the Git close operation returned `undefined`, and reference serialization threw
before completing fork and Preview cleanup. The pointer is already committed;
recovery must resume this exact publication, never create another release.
The recovery fix is prepared for deployment, with post-pointer failures retained
as `closing` and exact session/submission/publication identity checks.

Browser use also found root-relative navigation and stylesheet URLs escaping
the `/systems/<system>/` prefix. A serving fix is prepared that rebases browser
HTML/CSS while leaving immutable stored bytes and `/bundle/` consumer bytes
untouched. A new browser pass is required after deployment.

Rollback, independent concurrent authoring, conflict handling, all ten Request
publications, and source cutover remain outstanding. Production portal sources
and domains were unchanged by this disposable publication.
