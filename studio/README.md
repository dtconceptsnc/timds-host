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

## The dashboard

The sidebar is the list of Design Systems the caller can see, one link per
system (name and `systemId`), with the selected one marked active and
`aria-current="page"`. The top bar carries the selected system, the view tabs
(Overview, Sessions, Review, Activity), the feed indicator and Refresh.

The Overview explains the three ways to make a change, each as a card:

1. **Open Studio.** The primary button creates a working session on the
   current system (`POST /api/timds/sessions` with a per-card idempotency key,
   regenerated after each success) and opens the Studio for it. **Start from a
   draft…** opens the same dialog as the Sessions page.
2. **Connect over MCP** (badged `preview`). The host's authenticated read MCP
   endpoint, `<origin>/api/timds/mcp`, for reading the published system and
   filing gaps as Requests, plus the toolkit commands that let an agent edit
   (`timds auth login --oauth`, then `timds mcp`). The card says that editing
   over MCP is not production-ready.
3. **Edit locally with npm.** Install `@dtconcepts/timds` globally, log in
   with OAuth against this origin, `timds start <systemId>` to pull a session
   to disk, `timds dev`, and `timds submit` to send it back for review.

Each snippet has a **Copy** button (the Clipboard API; no inline script). The
toolkit version in the snippets is the `TOOLKIT` constant at the top of
`app.js`; keep it in step with the root `package.json`. Below the cards the
Overview lists drafts and sessions, recent Requests and the last releases. The
Request composer lives on the Sessions page.

## The steering model

Studio is a steering console, not an editor. **Agents are the only writers.**
Humans direct the work with Requests and decide with publish, rollback, close and
invite. Studio never pulls source files and refuses the snapshot, `update`,
`submit` and `claims` session routes before a request leaves the tab. Working
areas (claims) are shown read-only; agents declare them as they edit.

- **Requests.** The composer (on the Sessions page) targets a new session
  (default), an open session or a shared draft from `active-work` (only those the caller owns or publishes,
  as the host requires). Each Request keeps its UUID, original prompt and target
  across an ambiguous response or retry; a later returned session cannot change
  that target. A Request row shows the runner strip (queued, starting, running,
  submitting, submitted) and `queued, N ahead`. While it is queued or running,
  Studio reads it every 3 seconds until it is terminal or the live feed starts
  reporting it.
- **The Studio is the session.** "Open Studio" on any session, draft, Request
  or activity row (`#source=…&view=studio&session=…`; the older
  `view=sessions&session=…` hash lands in the same place) opens a full-height
  workspace with three columns. The middle column is the live view: the session's
  live URL in a sandboxed iframe (`allow-scripts allow-same-origin allow-forms`,
  `referrerpolicy="no-referrer"`) under a chrome bar with the state strip
  (starting, waking, ready, running, sleeping), the URL, a desktop/phone width
  toggle and open-in-new-tab. Opening a sleeping session or sending it a Request
  shows `waking` until the runtime reports ready. The frame reloads in place on
  `updated`, `request_submitted` and `live_state: ready` feed events for that
  session; refreshes patch the columns around it and never rebuild it. A frame
  that fails (an error, a CSP refusal, or no load within 20 seconds) shows a
  card with the URL and an open-in-new-tab button. There is no file viewer and
  no editor.
- **The stream (left column).** This session's feed events and the source's
  release events, oldest first, with All / Chat / Events filters. Every Request
  in the session is a chat thread: the prompt as the requester's message (from
  `request_received`, or this tab's own tracked Request before the feed echoes
  it) and the designer's progress as steps beneath it (`request_started`,
  `claimed`, `live_state`, `updated`, `submitted`, `request_submitted`,
  `request_failed`), with the current runner state as the live step. Other
  events are single rows; releases are highlighted. The composer at the bottom
  sends a Request to this session (Cmd/Ctrl+Enter sends). Conflicts for the
  session appear above the composer with the usual read-only receipt and
  **Ask the agent to resolve**.
- **The rail (right column) stays basic.** The current published version,
  this session's submissions with the stage strip, **Publish…** (publishers
  only) and **Preview ↗**, the session's people (members only, no invite
  form), the session's state (status, live view, designer, queue, expiry) and
  close. Invitations, working areas, other sessions and the release history
  stay on the dashboard pages. The top bar carries the
  dashboard breadcrumb, the current release label, the presence avatars and
  the feed indicator. Review still embeds each submission's Preview with the
  same frame component.
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

## Loading and busy states

Every wait has a visible indicator, and all of them are CSS driven (no inline
styles, so the CSP is unchanged):

- **Buttons.** Every button action runs through `perform`, which disables the
  control and sets `aria-busy="true"` until the action settles. A busy button
  keeps its label and shows a small spinner after it. This covers Connect,
  Refresh, Send Request, Open Studio (in the new-session dialog), Create draft,
  Publish, Build check only, Restore release, Close and every retry. The
  Connect button stays busy while the browser leaves for `/authorize`.
- **Pages.** The static shell shows "Checking your sign-in…" until `app.js`
  decides between the welcome page and the workspace. A workspace without
  `active-work` yet shows "Loading your workspace…", and the Studio route
  without the session's status shows "Opening the session…", each as a
  centred block with a spinner and `role="status"`.
- **The top progress bar.** A thin bar at the top of the viewport runs while a
  user-visible load is in flight: the sign-in exchange, the first `me` and
  catalog reads, a route's `active-work` and `submissions` reads, and a
  session's `status` read. It appears after 250 ms so short loads do not
  flash. Background polls and feed-driven refreshes do not show it.
- **Dialogs.** The new-session dialog shows "Starting a working session…"
  while the host creates the session; the publication dialog shows the
  preflight check line with a spinner.
- **Frames.** A live view or Preview frame carries a "Loading the live view…"
  (or "Loading the Preview…") bar above it until the frame's `load` event, and
  "Reloading with the latest change…" while a feed event reloads it in place.
  The 20-second fallback card replaces the bar. While a session is `starting`
  or `waking` and has no live URL yet, the stage shows "Starting the session…"
  or "Waking the session…" instead of the empty fallback; refreshes keep that
  placeholder in step with the session's state.
- **Requests.** A Request this tab has sent but the host has not acknowledged
  yet shows a `sending` badge on its card, and "Sending" as the live step in
  the Studio stream. The feed indicator pulses while connecting or
  reconnecting.

With `prefers-reduced-motion`, spinners fade instead of rotating and the
progress bar is a static line.

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
The two-row phone header is unchanged. The Studio stacks the live view first
(70% of the viewport), then the stream with its own scrolling list, then the
rail; below 960 px the three columns become one.

No tests were added per the user's instruction. Syntax was checked. Browser
acceptance must use the real deployed host and a disposable source; this file
does not claim that acceptance has passed.
