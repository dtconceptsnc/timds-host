# Standalone Studio

Serve these static files under `/studio/` on the host's authenticated application
origin. `index.html` references `/studio/app.js` and `/studio/style.css`. The host
owns asset routing and security headers. This client uses same-origin OAuth
registration, authorization-code flow with PKCE S256, and API v1; no portal
backend or frontend is involved. API and WebSocket URLs always derive from
`location.origin`, never from a host origin the server reports.

The access token and one-time PKCE transaction live only in this tab's
`sessionStorage`. The client requests read/write scopes without refresh tokens,
clears the code from the URL before exchange, checks state and expiry, and sends
the bearer token only to fixed same-origin API routes with redirects rejected.
Disconnect clears this tab's Studio state. Rendered data uses DOM text.

## The steering model

Studio is a steering console, not an editor. **Agents are the only writers.**
Humans direct the work with Requests and decide with publish, rollback, close and
invite. Studio never pulls source files and refuses the snapshot, `update`,
`submit` and `claims` session routes before a request leaves the tab. Working
areas (claims) are shown read-only; agents declare them as they edit.

- **Requests.** The composer targets a new session (default), an open session
  or a shared draft from `active-work` (only those the caller owns or publishes,
  as the host requires). Each Request keeps its UUID, original prompt and target
  across an ambiguous response or retry; a later returned session cannot change
  that target. A Request row shows the runner strip (queued, starting, running,
  submitting, submitted) and `queued, N ahead`. While it is queued or running,
  Studio reads it every 3 seconds until it is terminal or the live feed starts
  reporting it.
- **The live view is the interface.** Session and draft pages embed the live
  URL in a sandboxed iframe (`allow-scripts allow-same-origin allow-forms`,
  `referrerpolicy="no-referrer"`) under a state strip: starting, waking, ready,
  running, sleeping. Opening a sleeping session or sending it a Request shows
  `waking` until the runtime reports ready. The frame reloads in place on
  `updated`, `request_submitted` and `live_state: ready` feed events for that
  session; refreshes patch the page around it and never rebuild it. Review
  embeds each submission's Preview with the same component. A frame that fails
  (an error, a CSP refusal, or no load within 20 seconds) shows a card with the
  URL and an open-in-new-tab button. There is no file viewer and no editor.
- **Publication.** Preflight, optional build-only check, explicit publish and a
  stage strip (preflight, merge, build, prepare, release, flip, close) driven by
  the publication status and by `publication_stage`, `publication_failed` and
  `published` events. Rollback checks the selected immutable version, then
  requires the user to restore it.
- **Conflicts go back through an agent.** When a session's runner is
  `conflicted`, or a publish preflight returns 409 with `conflicts`, Studio shows
  the receipt read-only (path, key, base, mine, theirs, with swatches for hex
  colours) and one button, **Ask the agent to resolve**. It sends a follow-up
  Request to the same session, for example: `Resolve the conflicts in this
  session and submit: tokens.json#color.accent — mine #2f5d50, theirs #29452c
  (base #375638). Keep the intent of the latest Request and prefer the value
  that satisfies it; update related tokens for consistency.` There is no
  mine-or-theirs chooser.
- **People.** Owners and publishers invite people and agents from the source's
  principal directory into sessions and drafts, and can close them.

## Live feed and presence

Once a source is selected, the client opens the host's live feed: it POSTs
for a single-use ticket, opens a same-origin `wss://` socket with `after` set to
the last `seq` it holds, appends `event` messages to the activity rail in `seq`
order and refreshes `active-work` (debounced) when a session, draft, Request or
publication changed. The activity rail (right column on desktop, below on
phone, full width on Activity) lists these events newest first with the actor,
the event in plain words, its note and a relative time.

`presence` messages fill the top-bar indicator ("Live", "Reconnecting" or
"Polling") and the viewer avatars on session and draft rows and in the session
header (initials, full name on hover, agents tagged). The client sends
`viewing` when a session or draft page opens, again when the feed's `ready`
message arrives after each (re)connect, and every 5 minutes while the page is
open, hidden or not; each one refreshes the LiveSession keepalive. It sends
`viewing: null` when leaving the page. It sends `ping` every 25 seconds and
treats a missing `pong` within 10 seconds as a dead link. Reconnects use a fresh
ticket and the last received `seq` with backoff from 1 to 30 seconds
(immediately after a 4100 replay continuation; never after a 4410
archived/deleted close). The 12-second poll stays as the fallback while the feed
is down and slows to 60 seconds while it is live.

## Content Security Policy

The CSP names the host's `wss:` origin in `connect-src`. `frame-src` lists only
the origins in `TIMDS_STUDIO_FRAME_ORIGINS`: space-separated `https://` origins
or one-level wildcard patterns matching `^https://(\*\.)?[a-z0-9.-]+$`. Today
that is the account's own `workers.dev` subdomain
(`https://*.<workers-subdomain>.workers.dev`); later, whatever custom domain
masks live and Preview URLs. Nothing wider (`https://*.workers.dev` is refused).
With the setting empty, `frame-src 'none'` applies and Studio shows the
open-in-new-tab card instead of frames. Studio itself keeps
`frame-ancestors 'none'`. Swatches set colours through the CSSOM, so no inline
styles are needed.

## Layout

At phone width (390 px) every screen is one column with 44 px tap targets and no
horizontal scroll; frames are about 55% of the viewport height, the activity
rail stacks below, and text fields use 16 px type so the browser does not zoom.
The two-row phone header is unchanged.

No tests were added per the user's instruction. Syntax was checked. Browser
acceptance must use the real deployed host and a disposable source; this file
does not claim that acceptance has passed.
