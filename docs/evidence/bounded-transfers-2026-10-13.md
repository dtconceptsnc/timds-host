# Bounded native file transfers — 2026-10-13

Production provider-URL acceptance exposed long serial source transfers: Pierce
has 785 files (about 31 MiB before base64 encoding). Its dry runs returned a
server error and then a sanitized native-repository connection failure, including
capability cleanup. This does not establish that transfer duration caused the
connection failure, but serial transfer was keeping repository preparation close
to its existing ten-minute deadline. WPL's smaller source required about 19
minutes in its successful publication workflow.

Snapshot persistence and the isolated build/metadata file-copy loops now transfer
at most four independent files concurrently. Every pending transfer drains before
an error reaches container cleanup. Repeated content digests are transferred
once, manifests retain their original ordering, and no manifest is committed
when any transfer fails. Existing path, size, digest, immutable-write and source
identity checks remain in place; Git operations and publication gates are still
serialized. This changes transport scheduling, not source or release bytes.

Validation: the six file-tree tests and two dependency-cache tests pass, including
new bounded-concurrency/deduplication and failure-drain checks. Typecheck and the
native build pass. The broader repository-adapter test file has three existing
fixture failures (`store.sessionRepository` missing in two fixtures and one
502/200 fixture mismatch); the identical three failures were reproduced from an
unchanged HEAD archive. Those fixtures were not modified by this correction.

Deployed Worker version `c8eadc40-0f8f-4ed8-b60e-cdcec2dcb97d` at `2026-10-13T19:48:15.887316Z`.

Pierce's first post-deployment full dry run passed from `19:48:38.529Z` to
`19:58:03.298Z` (9 minutes 25 seconds): clean currency, unchanged main revision,
no auto-rebase, and `buildChecked: true`, using the original session and submission.
There is no successful pre-change Pierce timing baseline, so this establishes
successful live execution rather than a measured speedup ratio.
