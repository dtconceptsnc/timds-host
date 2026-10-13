# Native media live acceptance — 2026-10-13

The disposable host fixture passed live native media acceptance using released
`@dtconcepts/timds` `0.1.472`. Source
`6ffb48ea-862e-42de-9303-5edcbe8829d5` remained the original N10 fixture; these
operations did not create a publication. The sanitized
[receipt](native-media-acceptance.json) records actual CLI upload HTTP responses,
part ETags, exact public bytes, catalog reads, cancellation and archive readback.

The actual CLI uploaded a 54-byte file and a 34,603,008-byte file. The latter
selected multipart, transferred three parts (16 MiB, 16 MiB and 1 MiB), and
completed using their returned ETags. Both public GET responses matched the
original bytes and SHA256 exactly. HEAD returned the expected length, MIME and
ETag; `Range: bytes=17-48` returned 206 and the exact 32 bytes. Authenticated
media listing and the public MCP `read_derived_layer` catalog contained the same
ready asset IDs and hashes.

This acceptance found and fixed a full-response status bug: R2 supplied range
metadata even for a complete read. Commit `a7a098a` selects 206 only for an
explicit GET range and returns 200 for full GET/HEAD. Syntax, typecheck and the
full Worker/container build passed. Worker version
`0f950d87-a41f-4060-b781-6bc0d2d46192` was deployed, and both original assets
passed GET 200 / HEAD 200 / range 206 at `16:24:48Z`. Earlier 206 full responses
are not counted as successful acceptance.

A separate 33 MiB multipart reservation transferred its first 16 MiB part, then
canceled. Cancellation and its replay returned `pending:false`; a subsequent
part request returned 409 and the public URL returned 404. Both completed
assets were then archived. Their durable archived IDs and hashes remained in
the repeated archive response, and fresh public GETs returned 404 immediately.
The current `.5` and immutable `.4` release stamp byte hashes were unchanged
across archive at `16:24:59Z`–`16:25:04Z`. This verifies origin reads; existing
copies of public bytes held by a client are outside archive revocation.

The [authenticated MCP receipt](authenticated-mcp-read.json) separately proves
an actual MCP SDK client listed tools and read tokens using the operator's
existing own-human OAuth grant. Anonymous initialization returned 401 with the
protected-resource discovery challenge. This is not a fresh CIMD authorization
or `report_gap` write acceptance claim.

No tests or test harnesses were added. Temporary operational clients drove the
real deployed endpoints and retained sanitized evidence. Production source
conversion, public routing and original N10 publication recovery are tracked
separately.
