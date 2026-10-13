# Original Studio submission recovered and published — 2026-10-13

Original submission `0c81d4e0-afd8-4032-b07b-03ba7e227143`, session
`5f8b12cf-df51-4c41-b793-9104ff74963c`, completed normal authenticated publication
as `2026.10.13-13`, publication `fd83cad7-f422-4526-9a85-86100b13272f`.
The [sanitized receipt](manual-recovery-publication.json) contains the exact
recovery, preservation, preflight, close, public-stamp and rollback readbacks.

The deployed submission correction was replayed using the original body and
returned the original immutable review head
`8aa175f2e3dba0c14051faf858ee71dffcb38cbd`, branch
`review-0c81d4e0afd84032`. It retained the saved fork head
`560c366a949084e2647ac8bdf2c55659d502c18e` and the original intent note.
The saved `docs/studio-manual-proof.md` remained 114 bytes with SHA-256
`c557363da72aa5e5a0770c64492705398f10d7b2abbe4cf133e30a0d323bcf89`.

Before closing that fork, direct provider Git reads compared its tree with the
review and merged-main trees. Its only differing root entries were six exact
entries from its merged main parent; every other entry, including the docs and
src subtrees, matched the frozen review. A fresh fork-head read still returned
`560c366a…`. There were no additional saved author edits to discard. No fork,
review branch, submission identity or lease was reset to obtain this result.

After all [ten original batch publications](n10-recovery.md) completed,
normal publish preflight reported clean currency, automatic rebase, and exactly
one changed file with three added lines. Its target main matched the final
batch source commit `7f5242df2bc55e3af1117e906fa154dd66bc53ea`.
The unchanged submission then published through the ordinary queue and build.
Host readback confirmed `published` at `close`, no error, the original review
head and note hash unchanged, and the original session `closed`. Current and
pinned public stamps matched the new immutable version's source commit and
digest.

A normal API rollback dry-run to `.12` succeeded. Actual rollback selected `.12`,
and immediate restore selected `.13` with a reason recorded for each event.
Both current pointers were verified through authenticated metadata and public
stamps. The two pinned stamp bodies remained byte-identical. The final fixture
pointer is `.13`; rollback did not create a replacement release.

This completion uses the normal API after the earlier actual Studio save,
review and preview work. The user asked to stop further UI testing, so no
additional phone publish/rollback journey is claimed. No production transferred
source was modified by this acceptance. Fresh CIMD and a complete local
editing-MCP authoring journey remain separately
[unexercised](mcp-acceptance-boundary-2026-10-13.md).
