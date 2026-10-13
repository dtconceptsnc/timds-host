# Standalone Studio browser acceptance

Historical browser journey. The original recovered manual submission later
completed normal API publication, cleanup, rollback and restore; see the
[final receipt](manual-recovery-publication.md). The user stopped additional UI
testing, so no further phone publish/rollback journey is claimed. Current host
URLs use the `timds.workers.dev` account subdomain; URLs below record the earlier
browser session.

Live acceptance on October 13, 2026 uses only the disposable host source
`6ffb48ea-862e-42de-9303-5edcbe8829d5` (`timds/cf-preview-source-proof`).
The host is `https://timds-host-69.ratebucket.workers.dev`; no production source
is edited by this workflow. This is an actual Chrome journey, not a test harness.

The existing staff identity signed into `/studio/` using the host's PKCE OAuth
flow after the consent Origin/referrer correction. The browser receives only
its ordinary scoped OAuth credential, held in this tab's session storage. The
catalog and active workspace loaded with the expected fixture and permissions.

At 390 × 844, Studio created shared draft `studio-phone-proof-69`, session
`5f8b12cf-df51-4c41-b793-9104ff74963c`. Its working-area claim is
`docs/studio-manual-proof.md`, with the note “Studio phone workflow: isolated
documentation edit.” A later reload read the durable draft, claim, and `ready`
live state back successfully. The phone header's original clipped Disconnect
control was fixed; the current stylesheet uses a two-row action area.

The saved Request `71a9b933-f7c9-4f09-a7cc-1a358f33910c` asks for only a new
`docs/studio-phone-proof.md`, requires review, and explicitly forbids publication.
It targets a new session. Its initial attempt failed with HTTP 500 and a
subsequent read returned 404. The UI retained the original ID/prompt and showed
an unacknowledged state. After deployment `276b6f45-167c-406d-a9b9-6f41ccdef806`,
a single exact-ID retry showed `queued` and removed the error. This establishes
Request acceptance only. It later reached `dead_letter` with the persisted error
“Designer Request execution failed” and no attached session. The runtime owner added fixed-stage provider diagnostics. On deployment
`26da3dd5-5e0e-42dc-90be-885c967e9e10`, one further exact-ID retry was
authorized and showed `queued`; no new Request was created. It again reached
`dead_letter`. The runtime owner traced the Preview provider failure to Workers
rejecting the `redirect: error` fetch option before making a network request.
The adapter correction uses manual redirects and still rejects redirect responses;
deployment `3d88ce66-aee0-4a4d-bb04-95db7db69747` was followed by one
same-ID retry. This attempt created native session
`9fce67ce-39fb-462d-8fee-b549e167b8d0`, then the browser showed `failed` with
“The Request failed or exceeded its time limit.” Native execution diagnosis,
model completion, submission and review remain pending.

After the configured model was corrected to `gpt-6-sol`, deployment
`74d5b5fe-f77b-448f-b5f7-2705e9d452ab` accepted fresh Request
`a8d19bc9-11cb-4d60-93e5-591999562bf3` from the phone UI with the same
bounded documentation intent. The original terminal failed Request remains an
audit record. Native execution completed at 12:30:52Z with session
`bea77f26-c8be-4363-8740-302e0a4098d5` and submission
`0da402f3-da45-4160-b952-2ad7ce63c9a2`; the runtime owner verified its
`submitted` receipt without an error. The phone Review screen showed the exact git diff: one new mode-100644
`docs/studio-phone-proof.md`, exactly the requested three lines, and no changes
to existing files. The actual branch Preview opened successfully in Chrome with
the fixture's rendered Overview. The review screenshot is
`/tmp/timds69-studio-phone-request-review.jpg`. No publication was requested by
this workflow.

The separate CLI-owned live session `e0dc69fe-cd08-4cd2-90b2-73096ed4a1ea`
was inspected without mutation. After its initial cold start, its `/web/spacing/`
page visibly rendered `motion.fast`, `--motion-fast`, and the CLI's `170ms` change.
The screenshot is retained locally at `/tmp/timds69-live-motion-170ms.jpg`.
The draft phone screenshot is `/tmp/timds69-studio-phone-draft.jpg`.
The verified corrected header is `/tmp/timds69-studio-phone-header.jpg`, and the
visible Request failure is `/tmp/timds69-studio-phone-overview.jpg`. The default
desktop layout was also inspected and captured at
`/tmp/timds69-studio-desktop-overview.jpg`; the temporary viewport override was
reset after that phone layout proof, then reapplied while the phone file workflow continues.

Repository operations can hold the source coordinator while a sandbox starts.
Studio now bounds ordinary GET requests and offers a retry while preserving the
existing sign-in, instead of requiring a new OAuth connection. The repository
file-export read has a separate three-minute deadline because it may cold-start a
container. Initial file reads did not load an editor. A later read after the
source queue cleared failed with the exact message “This session is busy; retry
when its current operation finishes.” The existing session operation/lease must
settle through normal recovery before the manual file workflow continues; this
is not established as a browser timeout. The next file export succeeded and displayed the source editor. The phone UI
added only `docs/studio-manual-proof.md` with the heading “Studio manual proof”
and the requested documentation sentence, then sent one Save in session update
with the note “Studio phone manual edit: add only docs/studio-manual-proof.md.”
The update returned “The TimDS host could not complete this operation” after a
few minutes. The browser preserved its single unsaved change; no retry was sent.
The fork may have committed before the later error, so the outcome was
uncertain pending authoritative status/history/file inspection. The exact intended text was preserved before clearing only the local browser
buffer. A normal Refresh files read then returned “This session is busy; retry
when its current operation finishes.” No lease was reset or fork modified.
The draft is preserved. Slow responses from a previously selected route are ignored after
navigation. Writes remain
uninterrupted and uncertain Requests keep their original IDs for recovery.

After the durable lease expired naturally, the operator's normal snapshot GET
returned HTTP 200 in 33.9 seconds: revision
`375e1ee00e5af53c925b0585f48f5d396ccd9e8a`, 69 files, and exactly the intended
three-line `docs/studio-manual-proof.md`. This confirms the original update
pushed before its response/checkpoint was lost. The read reconciled the stored
base revision; `last_update_hash` remained blank. No update was repeated and no
lease was cleared manually. A deployment interrupt is a possible cause of the
lost completion, but is not established by this receipt. A subsequent normal
Studio Open files read completed successfully at the phone viewport: 69 files,
zero unsaved changes, and the exact three-line `docs/studio-manual-proof.md`
visible in the editor. The operator captured this recovered state at
`/tmp/timds69-studio-manual-recovered.jpg`. No file was recreated or saved again.
Submission of this recovered draft remains pending the next coordinated browser step. The separate original CLI submission subsequently passed its real publication dry-run; see [the dry-run receipt](publication-dry-run-debug.md).

The long repository operation also delayed unrelated metadata. A narrow read
facade now lets status, active work, draft lists, Request reads, submission lists,
source metadata, and immutable public-version lookups read committed state without
waiting for the writer queue. Current D1 identity/source grant checks remain;
these paths do not reconcile authority, flush the outbox, or arm alarms. Git
history and file snapshots remain serialized. Studio renders session status
before requesting Git history, and clicking the current workspace retries a
failed route. `npm run typecheck` and the actual `npm run build` passed for this
change. Deployment `74d5b5fe-f77b-448f-b5f7-2705e9d452ab` includes the read
facade and Studio changes. A fresh browser reload loaded the fixture catalog,
active sessions and one CLI-produced review row. Metadata lists continued to refresh while the fresh Request started. A direct
read by the runtime owner returned the manual draft's status in 793ms. The
browser session route still waited for the native Request status read; a further
Studio-only change now paints ordinary metadata first and opens the selected
session independently. Typecheck and the actual build passed; deployment
`eec5b502-381e-4ad1-994b-b2b19e063cf7` includes this client correction.

Manual draft submission, publication, rollback, and final
cleanup are still in progress. The fresh Request completed and its submitted
change and real Preview were reviewed successfully. This receipt does not claim the full
host lifecycle or migration has passed.
