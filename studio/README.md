# Standalone Studio

Serve these static files under `/studio/` on the host's authenticated application
origin. `index.html` references `/studio/app.js` and `/studio/style.css`. The host
owns asset routing and security headers. This client uses same-origin OAuth
registration, authorization-code flow with PKCE S256, and API v1; no portal
backend or frontend is involved.

The access token and one-time PKCE transaction live only in this tab's
`sessionStorage`. The client requests read/write scopes without refresh tokens,
clears the code from the URL before exchange, checks state and expiry, and sends
the bearer token only to fixed same-origin API routes with redirects rejected.
Disconnect clears this tab's Studio state. Rendered data uses DOM text, and
source/Preview pages open separately with `noopener noreferrer`.

Requests retain their UUID, original prompt and original target across an
ambiguous response or retry; a later returned session cannot change that target.
The host remains responsible for permission, identity and idempotency checks.
Source updates send both revision and update-hash fences. Conflicts preserve
local edits and show the host response; the toolkit resolves conflicting keys.
Publication has preflight, optional build-only checking, explicit publish and
durable status. Rollback first checks the selected immutable version, then
requires the user to restore it.

The responsive client includes source selection, Requests, session and draft
creation, members, claims, direct text edits, submission diffs and Preview links,
publication progress, activity and rollback. Recent Request references are tab
local because API v1 does not expose a Request collection endpoint. Shared
sessions, submissions and events always come from the host.

No tests were added per the user's instruction. Syntax was checked. Browser
acceptance must use the real deployed host and a disposable source; this file
does not claim that acceptance has passed.
