# Issue 69 stopping point — 2026-10-13

The user requested a resumable stopping point before production cutover. Issue
[toperator#69](https://github.com/dtconceptsnc/toperator/issues/69) remains open.
Verify behavior through actual CLI, API and browser use; do not write tests.

## Code and deployment boundary

- Host work: [draft PR 1](https://github.com/dtconceptsnc/timds-host/pull/1),
  branch `codex/open-host-foundation-69`.
- Portal work: [draft PR 92](https://github.com/dtconceptsnc/toperator/pull/92),
  branch `codex/timds-host-cutover-69`, isolated worktree based on portal master
  `9dc40abf9c4b2e0bbff81d2684435b23f160557a`.
- Toolkit [PR 104](https://github.com/dtconceptsnc/timds-toolkit/pull/104)
  is merged and npm `@dtconcepts/timds@0.1.472` is released. Both repositories
  use Apache-2.0. The release also fixes OAuth refresh during long commands and
  waiting for recoverable publication cleanup.
- The live host is still commit `f655a24`, Worker version
  `1d21ec4a-2c0b-498a-9c0a-ec24ad6d34e5`. Later changes, including FIFO waits,
  Studio retries, and native media, are committed but **not deployed**.
- Host D1 migrations 0001–0004 are applied. Portal OAuth/source ownership/
  consumer-fence SQL is **not applied**. Production portal is still `9dc40ab`.
- Four correctly identified organization shells exist on the host. They have
  no imported production sources or grants. Production source ownership,
  domains, pointers and writers have not been transferred.

## Actual-use evidence

- The released CLI completed publication
  `f38e6324-030a-4d02-aa26-6c24e0104fc6` as version `2026.10.13-2` and resumed
  that same publication successfully after cleanup. Published HTML, current
  and pinned assets, read MCP tokens/pages and derived bundle hashes passed.
- [Collaboration](native-collaboration-acceptance.md) passed start/join,
  advisory claims, independent-key merge, exact same-key conflict, stale
  resolution rejection, resolution and close. Both workspaces used the same
  human; this is not evidence of cross-principal collaboration.
- The separate disposable source passed archive, restore, deletion, retained
  audit and no-resurrection checks. Production sources were not deleted.
- Ten real designer Requests submitted independent token changes, all reviewed
  with no author-side conflicts. The first two published consecutive versions
  `2026.10.13-3` and `2026.10.13-4`; the full ten-publication acceptance is not
  complete. All eight unfinished original Workflow instances are paused,
  verified at `15:03:20Z`; the first two remain complete. The third finished
  release staging before pause and has not run flip. Preserve all existing IDs
  and receipts. See [queue recovery](../publication-queue-recovery.md) and the
  [provider pause receipt](n10-workflow-pause.json).
- Phone Studio navigation, designer Request/review/preview, and a saved manual
  file edit were exercised. Manual submit is still unresolved: session
  `5f8b12cf-df51-4c41-b793-9104ff74963c`, submission
  `0c81d4e0-afd8-4032-b07b-03ba7e227143`. The latest browser retry reported
  “Submission changed; retry with a new submission” after earlier busy errors.
  The saved file is `docs/studio-manual-proof.md`; preserve it and diagnose the
  durable submission state rather than clearing leases or losing the draft.
- The legacy artifact backfill completed at `14:51:25Z`: 36 releases, 8,596
  verified objects, 47 verified public reads, 11 retained bundle
  representations, no pointer changes or deletions. Nacho remains deleted/404.
  [Receipt summary](artifact-backfill-checkpoint.json).
- Native release conversion is only a dry-run: 8,591 objects, 550,356,950 bytes,
  zero conflicts. It must use a newly captured baseline before application;
  the old plan is evidence, not permission to bypass its freshness guard.
- Host and portal typechecks/builds passed. No new automated tests were written.
  The normal toolkit release workflow completed its existing required checks.

## Resume order

1. Read the workflow pause/recovery evidence, refresh existing authorized
   credentials as needed, and inspect current state before any mutation.
2. Deploy the committed host changes and public companion configuration. Check
   the earliest unfinished original workflow's version and durable queue steps
   before resuming/restarting more instances. Finish ten consecutive versions.
3. Resolve the manual Studio submission, finish phone publish and rollback,
   and exercise actual native single/multipart media upload, read/range/hash,
   cancellation and archive. Follow the native media acceptance runbook.
4. Finish the portal SQL/catalog review and source-transfer capability-drain
   proof. Configure production Artifacts/media bindings, explicit public-origin
   map, portal OAuth origin, and transfer issuer. Apply additive portal SQL only
   at the coordinated cutover boundary.
5. Capture fresh source/public baselines; convert immutable host releases;
   freeze/import/activate each of the three live sources with exact identities.
   Import Nacho's tombstone only. Preserve each publisher's separate identity;
   Tim's future invitation must be accepted through his own verified login.
6. Verify unchanged public bytes/domains and real portal OAuth use before
   removing obsolete VPS Design System execution paths. Keep shared website
   runtime helpers until their consumers are separated. Update deployed docs
   and complete review before closing the issue.

Private full migration receipts/configuration are retained under the operator's
`~/.config/timds/transfer69/` directory. The local batch checkpoint is
`/tmp/timds69-host-acceptance/designer-batch.json`, also backed up as
`~/.config/timds/transfer69/designer-batch.json`; preserve its IDs on resume.
The local batch watcher was stopped at the user's request. No new production
deployment or migration was started for this stopping point.
