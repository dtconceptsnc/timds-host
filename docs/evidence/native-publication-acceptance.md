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

Its first close attempt failed:
the Git close operation returned `undefined`, and reference serialization threw
before completing fork and Preview cleanup. The pointer is already committed;
recovery must resume this exact publication, never create another release.
The recovery fix was deployed in `04d8b165`. Automatic retry completed at
14:13:02.920 UTC: the same publication is `published`, its session is `closed`,
and the API error is null. The original pointer event and published timestamp
were preserved. See [the cleanup receipt](publication-cleanup-receipt.json).

Browser use also found root-relative navigation and stylesheet URLs escaping
the `/systems/<system>/` prefix. The deployed serving fix rebases browser
HTML/CSS while leaving immutable stored bytes and `/bundle/` consumer bytes
untouched. Actual browser navigation from Spacing to Components and back passed,
and the styled spacing page displayed the published `170ms` value.

All ten concurrent designer Requests returned submitted changes with independent
spacing keys. Their actual diffs were reviewed before queueing publications;
each contains its requested key plus the generated combined-token mirror, with
no removed values. Publication completion and rollback remain outstanding.
Separate live collaboration verification also exercised different-key merge and
same-key conflict handling. Source cutover remains outstanding; production
traffic and source ownership were unchanged by this disposable publication.
