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

Once a source is selected, the client opens the host's live feed: it POSTs
for a single-use ticket, opens a same-origin `wss://` socket with `after` set to
the last `seq` it holds, appends `event` messages to the activity list in `seq`
order and refreshes `active-work` (debounced) when a session, draft, Request or
publication changed. `presence` messages fill the top-bar indicator ("Live",
"Reconnecting" or "Polling", plus how many others are here), and the client
sends `viewing` whenever the open session or draft changes. It sends `ping`
every 25 seconds and treats a missing `pong` within 10 seconds as a dead link.
Reconnects use a fresh ticket and the last received `seq` with backoff from 1
to 30 seconds (immediately after a 4100 replay continuation; never after a 4410
archived/deleted close). The 12-second poll stays as the fallback while the
feed is down and slows to 60 seconds while it is live. The CSP names the
host's `wss:` origin in `connect-src`.

No tests were added per the user's instruction. Syntax was checked. Browser
acceptance must use the real deployed host and a disposable source; this file
does not claim that acceptance has passed.
