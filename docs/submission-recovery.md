# Recovering an interrupted submission

A submission is reserved by the exact normalized change-set hash before Git
writes begin. An interrupted operation must retain that submission ID and review
branch. Repeating the same body resumes that reservation; changing the note,
base or files creates a different request and is not recovery.

The repository adapter checks the change-set hash and base against the durable
reservation. A pre-existing review branch is read before preparing any new merge.
Its commit must descend from the original base and be an ancestor of the current
session fork. Recovery returns that frozen review commit and retains the current
fork revision/files, including any saved work that arrived after the review
branch was created. It neither resets the fork nor overwrites the review branch.
Missing ancestry or a changed receipt fails closed.

New reservations use repository receipt format 1. Every submission creates a
commit with its submission ID, request hash and original target-main revision,
even when its resulting tree is unchanged. The reservation's creation time fixes
the commit date. If only the fork push succeeded, a replay validates that marked
commit and creates the still-absent review branch from it. If the review push
succeeded, a replay reuses it. The stored original target revision keeps the diff
stable when main advances. Final session/submission checkpoints still require the
session lease; a lost final response remains recoverable through the normal API.

Existing reservations have no format marker. Their original review branches are
preserved and validated by the original-base/review/fork ancestry chain. Their
review diff uses the common ancestor of the frozen review commit and current
target main. Existing submission-marked fork commits can also finish an absent
review push without merging newer main into the same submission.

## October 13, 2026 manual Studio diagnosis

Read-only durable and provider inspection established this sequence for one
submission (identifiers and commits are kept in the private operational record):

- The reservation remains `preparing` with no checkpointed `head_commit`.
- Its review branch points to a review commit whose parents include the saved
  manual-edit base and then-current main.
- The fork later advanced to a second commit, with the review commit and newer
  main as parents, using the same submission message.

The former implementation merged new main and pushed the fork before checking
whether its already-created review branch had a different head. This explains
the observed “Submission changed; retry with a new submission” error. The reason
the original response/checkpoint was lost is not established by these reads.

Syntax checks, host typecheck and the full Worker/container build passed for this
fix. No tests were added. The deployed fix was replayed with the exact original
body through the normal authenticated API. It returned HTTP 200, the same
submission ID in `submitted`, unchanged review head `8aa175f2…`, and preserved
fork revision `560c366a…`. The returned snapshot retains the original
`docs/studio-manual-proof.md` (114 bytes, SHA-256
`c557363da72aa5e5a0770c64492705398f10d7b2abbe4cf133e30a0d323bcf89`).
No lease, source/session/submission identity, review branch or saved file was
replaced. The same original submission subsequently completed normal API
publication as `.13`; the session closed and API rollback to `.12` followed by
restore to `.13` preserved both pinned stamps. See the
completed acceptance receipt (private operational record).
The user stopped additional UI testing, so this does not claim a further phone
publish/rollback journey.
