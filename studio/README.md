# Standalone Studio

Serve these static files under `/studio/` on the host's authenticated application
origin. `index.html` references `/studio/app.js` and `/studio/style.css`. The host
owns asset routing and security headers. This client uses same-origin OAuth
registration, authorization-code flow with PKCE S256, and API v1; no portal
backend or frontend is involved. API and WebSocket URLs always derive from
`location.origin`, never from a host origin the server reports.

The access token, its rotating refresh token and the registered OAuth client
live in `localStorage` under the `timds.studio.v1.` prefix, shared by every
Studio tab at this origin, so a new tab, a link opened from an agent and a
browser restart all land signed in; the one-time PKCE transaction stays in the
starting tab's `sessionStorage`. The client requests
`timds:read timds:write offline_access`, clears the code from the URL before
exchange, checks state and expiry, and sends the bearer token only to fixed
same-origin API routes with redirects rejected. The access token lasts about an
hour. When a call finds it within five minutes of expiry, or already expired
after the tab was in the background, the client first renews it through the
same-origin `/token` refresh grant (one renewal in flight per tab, bound to the
registered client and the API resource) and stores the rotated pair. Before
posting the grant a tab re-reads the stored pair and uses a newer one another
tab rotated in, and every tab listens to the `storage` event to adopt a
rotation and to treat a cleared token as a disconnect, so tabs never race the
host's one-time previous-token grace. The host issues refresh tokens for 30
days, so the sign-in lasts up to that long and ends with Disconnect or a
refused refresh. A refused refresh drops the refresh token and Studio asks the
person to connect again once the access token expires; a `401` from the API
disconnects at once. Disconnect clears the shared sign-in, so every tab signs
out, along with this tab's Studio state. The trade-off is that the token now
persists on disk at the origin until then; the CSP and the same-origin-only
sends are unchanged. Rendered data uses DOM text.

## The dashboard

The sidebar is the list of Design Systems the caller can see, one link per
system (name and `systemId`), with the selected one marked active and
`aria-current="page"`. The top bar carries the selected system, the view tabs
(Overview, Deliverables, Sessions, Review, Activity), the feed indicator and Refresh.

The Overview leads with the published collection: the public guide, release
label, counts of guidance pages, tokens and implementation files, and a small
palette taken from the actual published color tokens. **View all deliverables**
opens the Deliverables view; **Prepare client handoff** previews a copyable
introduction containing the public links and implementation instructions.
The handoff contains no Studio invitation, session link or bearer token.
Client links require HTTPS public-facing domain names: provider domains
(`workers.dev`, `pages.dev`, `r2.dev`) and IP addresses are excluded. If the
published root or captured release base is not suitable, Studio shows a
public-address setup state and a refresh action instead of the collection's
share links. File, media, page and design links must also share the published
root’s origin, as must the captured release base.
Studio does not invent replacement hostnames; the host operator configures and
deploys the canonical public origin as described in
[public-facing domains](../docs/operations.md#public-facing-domains-and-client-handoff).

Below the collection, **Keep creating** explains the three ways to make a
change, each as a card:

1. **Open Studio.** The primary button creates a working session on the
   current system (`POST /api/timds/sessions` with a per-card idempotency key,
   regenerated after each success) and opens the Studio for it. **Start from a
   draft…** opens the same dialog as the Sessions page.
2. **Send your agent** (badged `preview`). The primary button, **Send to your
   agent…**, opens the agent handoff dialog described under "Agent handoff"
   below, scoped to the selected Design System. The host's authenticated MCP
   endpoint, `<origin>/api/timds/mcp`, lets an agent read published guidance,
   edit files in a hosted session, submit changes for review, or send a Request
   to the designer. The client signs in with OAuth and requests read/write
   access; existing Design System permissions still apply. Remote MCP also
   supports checks, invitations and explicit publisher preflight, publication
   and rollback, sharing Studio's host lifecycle. Deployed acceptance remains
   owed; the card keeps its preview badge until that is verified. See
   [designer MCP](../docs/api/designer-mcp.md) for the tools and
   [contributor setup](../docs/contributing-design-systems.md) for installation,
   connection and the complete workflow.
3. **Edit locally with npm.** Install `@dtconcepts/timds` globally, log in
   with OAuth against this origin, `timds start <systemId>` to pull a new
   session to disk, `npm ci`, `timds dev`, and `timds submit` to send it back
   for review. The card says that this starts a new session and points at the
   join command under **Invite…** for one that is already open.

Each snippet has a **Copy** button (the Clipboard API; no inline script). The
toolkit version in the snippets is the `TOOLKIT` constant at the top of
`app.js`; keep it in step with the root `package.json`. `timds start` carries
`--portal-url <origin>`, because a toolkit that has no workspace yet does not
otherwise know which host to call. Below the cards the
Overview lists drafts and sessions, recent Requests and the last releases. The
Request composer lives inside each session's Studio.

## Sessions and drafts

The Sessions page (`view=sessions` without a session ID) is a creation and
management index. **New session** opens a dialog to choose the main Design System
or an open shared draft. **New draft** asks for a draft name. Each successful
creation enters that workspace's Studio. The dialogs capture the source and
principal, retain the original name or draft selection and idempotency key after
an ambiguous response, and verify the returned session belongs to that source.
A late response cannot navigate a different signed-in identity; if the dialog
was closed, a notice directs the caller back to the Sessions list.

Separate Working sessions and Shared drafts lists show status, membership and
**Open Studio**. There is no Request composer, recent Requests panel, runner
strip, claim list or live-preview link on this page. Send Requests, watch the
agent and review changes inside Studio. The Overview retains its existing
activity and contribution options.

Callers with the host's `canManage` permission also see **Destroy…** beside each
active workspace. This action calls `POST /api/timds/sessions/:id/close` directly;
it does not first open the workspace or wake its runtime. Confirmation captures
the exact session ID, source ID and principal, and explains loss of unpublished
edits, removal of the working repository and review branches, stopping the live
runtime, and retention of published releases and recorded history. Destroying a
draft also destroys every active child session based on it. Pending submissions
are closed while their records remain.

Studio's rail uses the same destroy action. While cleanup runs, its controls
show a busy state. A matching `closed` or `expired` receipt removes the workspace
from the active lists and returns an affected open Studio to Sessions. Cleanup
errors stay visible in the dialog and management row; **Retry destroy…** retries
the same workspace. A host `closing` state remains listed, including after reload,
until cleanup is confirmed. Every attempt rechecks authority on the host.

## Creating and deleting Design Systems

Active host administrators see **Create Design System** and **Manage Design
Systems** in the sidebar. The management page uses the paginated administrative
system and organization catalogs; it includes provisioning, archived and deleting
systems that are absent from the ordinary workspace catalog. Completed deletions
are tucked under a collapsed **Deleted Design Systems** section at the bottom;
expand it to read deletion receipts. They remain absent from ordinary navigation.
Non-administrators keep the existing access-only empty state. An
administrator with no systems lands on the first-system creation state.

The selected system's **Overview** also has a **Delete Design System…** button
beside its heading, including at phone width. It is visible only to host
administrators. The button refreshes the administrative catalog and opens that
system's existing deletion receipt or a new cleanup review; switching systems,
leaving Overview or changing identity during the read cancels opening the dialog.
The same review is available through **Manage Design Systems → Delete…**.

Creation asks for a name and unique lowercase system ID. **Organization** defaults
to **New organization**, named after the system, and also offers existing active
organizations. New organizations receive a stable UUID saved before submission.
The namespace is automatic and hidden: the first configured namespace in the
sorted administrative catalog is captured in the saved creation input. The host creates
the pinned starter and repository, then grants the creating administrator read,
write and publish access. Studio does not upload or edit starter files. A
successful creation selects the system and opens its Overview.

Before submitting, Studio saves the exact operation UUID, source UUID and form
input in this tab's `sessionStorage`, scoped to the principal. Retry and reload
reuse those details, including a first-organization UUID; they do not generate
another system after an ambiguous response. **Resume creation** shows status
and retries the saved input. The admin catalog also supplies the creating
administrator's starter input for recovery from another tab or device. **Finish
setup** appears when the starter is ready but its initial access grant is still
owed; the catalog distinguishes this from a later intentional grant revocation.
Completion of the provision receipt alone does not imply that the final access
grant succeeded, so the original creation request is retried before opening it.
An explicit Disconnect clears the tab's saved inputs; server receipts remain.

**Access…** on each ready management row, and beside the selected system's
Overview heading, opens that system's access dialog. It reads the host's
publisher list and identity catalog (`GET /api/timds/admin/systems/:id/authority`
and `/principals`, following every cursor) together with the system's own
principal directory, and lists everyone who can read, write or publish plus the
designer agent, marking publishers. **Set permissions** chooses an active
identity that has already signed in to this host and sets read, write and
publish exactly as checked (write implies read); unchecking all three removes
that identity's access. Each change posts a durable authority operation
(`POST /api/timds/admin/systems/:id/authority`). Studio saves the operation UUID
and exact command in this tab's `sessionStorage`, scoped to the administrator,
source and principal, before the request leaves, and reuses them unchanged
while the same command is retried after a failure; a different command gets a
new UUID, and success clears the saved entry. The receipt must name the same
source and principal and carry a confirmed authority version, after which the
list reloads. Studio never matches an email address or creates an identity;
people who have not signed in are not offered, and reserved invitations stay
with the administrator API. The host closes a changed identity's live sessions
so they reconnect with their new permissions.

**Rename organization…** on each management row changes only the organization's
display name. The dialog explains that shared organizations change for every
system using them, and rejects an unrelated concurrent rename. Organization IDs,
system IDs, source UUIDs, namespaces and repositories remain fixed after creation.

**Delete…** prepares a read-only inventory with a durable operation UUID. Studio
shows its exact repository, affected sessions, forks, Requests, publishers and
media counts, and explains retained immutable releases and audit history. Native
systems require the exact repository name to be typed before confirmation.
Confirmation immediately removes the system from ordinary navigation and the
host finishes cleanup in the background. The dialog polls the receipt every
three seconds until completion or a paused state. **Refresh status** reads the
same operation; a failed native cleanup can be explicitly resumed with another
typed confirmation. A changed impact requires **Prepare a new review** and a
new confirmation. An ambiguous prepare or confirmation retains the operation ID.

The admin catalog's deletion operation ID reopens confirmed cleanup after reload,
including completed tombstones. Unconfirmed reviews remain resumable in the
original tab. **Retained history** reads the bounded audit and session descriptors.
Partial provisioning may be deleted only when the host has exact ownership
receipts; unknown repository ownership stays blocked. Imported systems show that
their original backend must fence consumers and supply signed verification.
Studio offers no proof entry or unsigned override; the operator completes or
resumes that workflow server-side and refreshes the receipt here. See
[source deletion](../docs/lifecycle-deletion.md) for cleanup and retention details.

When a deletion review is blocked by a session repository, Studio lists bounded
workspace IDs and statuses. Missing ownership evidence is distinguished from a
changed repository identity. **Go to Sessions** is offered only for accepted
active work whose existing Destroy flow can be reviewed separately. That link
does not open or destroy a workspace. Starting or terminal workspaces and changed
identities require operator verification. After cleanup, retry the review; Studio
never adopts a repository from its name or bypasses the host's ownership checks.

## Published deliverables and client handoff

Deliverables groups the published brand reference, tokens, design catalog,
format specifications, implementation bundle and AI guide. Each available
export has a public link; missing documents say **Not included in this
release**. The file library searches bundle files, brand logos and imagery,
font files and public media by name or type, shows up to 60 matches at a time,
and links to the published files for opening or saving. Brand and media entries
are deduplicated by URL. A guidance directory links to up to 30 published pages;
the design card also opens the rendered catalog when its URL is available.

The implementation section explains how to explore the guide, install or use
the bundle, and give an AI tool the same context. It matches the developer
guides under [`docs/consuming/`](../docs/consuming/README.md): the copyable
command is `npx --yes @dtconcepts/timds@latest consumer init` with the system
ID and the public base, no toolkit version and no `--version`, so `init` pins
the release that is current when it runs. The `TOOLKIT` constant is not used
here. The command is offered only when the captured release has an immutable
version base and a matching bundle at the artifact root. Custom nested bundles
and imported same-label republications instead direct clients to the actual
file manifest. The AI step names no server and no tool names: it points at the
published guide and the AI guide (`llms.txt`), which lead to the tokens, brand
data and guidance pages, and the client handoff text repeats that pointer under
**AI TOOLS**. The main guide follows the current release; an immutable release
link appears only when the derived layer confirms that it represents the
captured publication.

The client first reads the existing source view to distinguish an unpublished
system from a failed read, then calls `read_derived_layer` over the fixed
same-origin `/api/timds/mcp` route. It supports JSON and SSE responses and uses
a 45-second timeout. All public document and file links come from that captured
published layer; no unpublished source files are read. Requests never use an
origin from the response, and public assets are not fetched into the OAuth
origin. External links use the existing safe URL check and open without an
opener or referrer.

The collection loads independently of sessions and Requests. It is retained
while navigating the same system, refreshed when publication history changes
(including rollback), and explicitly reloaded by Refresh or **Try again**.
Switching systems, confirming deletion or disconnecting discards the prior
collection; late responses cannot replace the new system's content. A loading
panel, first-publication empty state and
retryable failure state are distinct. Clipboard failure selects the handoff or
snippet text for manual copying. The published collection uses the existing
static assets and CSP; its palette uses the same CSSOM swatches as conflicts.

## The steering model

Studio is a steering console, not an editor. **Agents are the only writers.**
Humans direct the work with Requests and decide with publish, rollback, close and
invite. Studio never pulls source files and refuses the snapshot, `update`,
`submit` and `claims` session routes before a request leaves the tab. Working
areas (claims) are shown read-only; agents declare them as they edit.

- **Requests.** The composer inside Studio targets that open session or shared
  draft (only for its owner or a publisher, as the host requires). Each Request
  keeps its UUID, original prompt and target
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
- **The stream (left column).** This session's own feed events, oldest first,
  with All / Chat / Events filters. Releases published from this session's
  submissions carry its id and appear; releases from other sessions and the
  source's earlier history stay on the dashboard Activity page. Every Request
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
  the session's unsubmitted changes, this session's submissions with the
  stage strip and changelog, **Publish…** (publishers only) and **Preview ↗**,
  the session's people (the member list, plus **Invite…** for the owner and
  publishers while the session is open), the session's state (status, live
  view, designer, queue, expiry) and **Destroy…**. Working areas, other
  sessions and the release history stay on the dashboard pages. The top bar carries the dashboard breadcrumb, the current release label, the
  Publishing pill while a release is in flight, the presence avatars and the feed
  indicator. Review still embeds each submission's Preview with the
  same frame component.
- **Changes since the last submission.** Every edit the host records for the
  session is an `updated` event, whichever agent or client made it: `update`
  and MCP `update_session` saves, draft integrations, and commits the host
  reconciles from the session's container (`details_json.outOfBandHead`).
  The rail's **Changes** section lists the `updated` events newer than the
  session's last `submitted` event and its newest submission, skipping
  rejected saves (`details_json.rejected`): who made each, what kind of change
  it was, its note and its merged keys, with a count. Studio still never
  submits: **Submit for review** (owner or publisher, open session) sends a
  Request to the session's agent, `Submit the current changes in this session
  for review. Write a note that summarises the N changes made since the last
  submission.`, the same way **Ask the agent to resolve** does, and the
  section in that tab shows "Submission requested" until the submission
  lands. When
  changes are pending but nothing is submitted, Publish says so instead of
  "Nothing to publish yet".
- **Changelog.** A submission's unified diff from the host becomes a file
  list with added and removed line counts on the rail's submission card (six
  files), on the Review card (six) and in the publish dialog (twelve), above
  **Publish release**, so the reviewer reads what goes out before publishing.
  A submission without a diff says so in the dialog and points at the Preview.
- **Publication.** Preflight, optional build-only check, explicit publish and a
  stage strip (preflight, merge, build, prepare, release, flip, close) driven by
  the publication status and by `publication_stage`, `publication_failed` and
  `published` events. While any publication for the selected system is
  `queued`, `running` or `closing`, a **Publishing** pill with its queue
  position, current stage or "finishing" sits in the dashboard top bar and the
  Studio header and opens Review; the Studio rail's Version section shows the
  same stage. The pill is filled from the `submissions` read and the same
  publication events, and disappears once the release is live or the
  publication fails. Rollback checks the selected immutable version, then
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
- **People.** **Send to your agent…** in the rail opens the agent handoff
  dialog scoped to this session (see "Agent handoff" below); it is shown to
  every member while the session is open. **Invite…** opens the Join Session widget: two
  copyable rows, each with a **Copy** button that falls back to selecting the
  text when the clipboard is unavailable. **Studio link** is
  `/studio/#source=…&view=studio&session=…&join=1`; anyone the Design System
  already authorizes who opens it is joined through
  `POST /api/timds/sessions/:id/join` with no `principalId`, sees a notice,
  and lands in that session's Studio. The `join` flag is removed from the hash
  before the join so a reload does not repeat it, and the hash survives the
  sign-in round trip; a failed join shows the host's error and the page then
  opens as usual. **Terminal** is the same invitation in the toolkit's words,
  `npx --yes --package @dtconcepts/timds timds join "<studio link>"`: the
  command signs in through the link's host origin if needed, calls the same
  join route as itself, and pulls the session into a new `./session-<id
  prefix>` folder. `timds join` takes a session id in every release and the
  link from toolkit `0.1.476`, the release `TOOLKIT` names; an older pin
  would break this row. Membership grants session access, not
  publication. There is no principal picker; owners, publishers and host
  administrators can destroy sessions using the host's current permissions.
  The invite dialog also offers **Send to your agent…** for the same session.

## Agent handoff

Designers direct agents, so the shortest path into the host is a button that
hands the designer's own agent everything it needs. **Send to your agent…**
on the Overview (scoped to the Design System) and in the Studio rail (scoped
to that session) open the same dialog. Nothing in it is sent anywhere by
Studio; every action copies text, downloads a file or opens the client's own
install link, and the agent then signs in as the designer through the host's
OAuth flow. The dialog contains:

- **A client picker** (Claude Code, Codex, Cursor, VS Code, Gemini CLI,
  Claude app, Other), remembered in this tab's `sessionStorage` under
  `agent`. The table of clients is the `AGENT_CLIENTS` constant in `app.js`;
  every entry adds the host's MCP server under the name `timds`.
- **1 · Connect once.** The one-time step for that client: a copyable command
  (`claude mcp add --transport http timds <origin>/api/timds/mcp`,
  `codex mcp add timds --url …` plus `codex mcp login timds`,
  `gemini mcp add --transport http timds …`, `code --add-mcp '{…}'`), an
  install link for clients that have one (`cursor://anysphere.cursor-deeplink/mcp/install?…`
  with the server config base64-encoded, `vscode:mcp/install?…` with it
  URL-encoded), or numbered steps plus the copyable URL for apps that take a
  remote connector in their settings. A help line says how that client signs
  in. Install links are plain anchors; Studio does not navigate to them itself.
- **2 · Send it into this session** (or the system). The brief, in a
  read-only code block with **Copy the brief** as the primary action. It
  names the MCP URL with its OAuth expectations, the system ID, the session
  ID when scoped to a session, and the Studio link, then tells the agent how
  to connect if it is not connected yet (CLIs run the command and stop if a
  restart or sign-in is needed; app clients ask the designer to add the server
  and stop until it is connected), and what to do once it is: call
  `get_skill` for the system and save the result at the path it names, then
  `join_session` (or `get_system`, `get_active_work` and `start_session`
  when no session is scoped), do the task, submit for review, report the
  submission and its Preview, and stop without publishing. The working rules
  themselves live in the skill, so the brief never restates them. The last
  line is `Task: <describe the change you want>` for the designer to replace.
- **3 · Or keep it as a skill.** The same `SKILL.md` the agent will fetch,
  read from the host through `get_skill` over the fixed same-origin
  `/api/timds/mcp` route (the `mcpCall` helper that `read_derived_layer`
  also uses) when the dialog opens, with a loading line, a retryable error
  state, **Copy SKILL.md** and **Download SKILL.md** (a Blob URL). The host
  renders the toolkit's `skills/timds-hosted-design-system/SKILL.md`
  template with this origin and system, so Studio shows exactly what the
  agent gets; see [designer MCP](../docs/api/designer-mcp.md). The skill is
  always system-scoped, because it outlives any session.

Clipboard failure in any of these selects the text for manual copying, as
elsewhere in Studio. The brief and the skill never contain a bearer token,
an invitation or a join flag: membership comes from `join_session` under the
agent's own signed-in identity, which must already have access to the Design
System.

## Loading and busy states

Every wait has a visible indicator, and all of them are CSS driven (no inline
styles, so the CSP is unchanged):

- **Buttons.** Every button action runs through `perform`, which disables the
  control and sets `aria-busy="true"` until the action settles. A busy button
  keeps its label and shows a small spinner after it. This covers Connect,
  Refresh, Send Request, Open Studio (in the new-session dialog), Create draft,
  Publish, Build check only, Restore release, Destroy and every retry. The
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
  placeholder in step with the session's state. A newly created session may
  return its source tree before its fork and live Worker exist. The host's
  later `live_state` event refreshes active work and session status; when the
  live URL arrives, Studio replaces the placeholder with the frame without
  a page reload.
- **Requests.** A Request this tab has sent but the host has not acknowledged
  yet shows a `sending` badge on its card, and "Sending" as the live step in
  the Studio stream. The feed indicator pulses while connecting or
  reconnecting.
- **Publishing.** Accepting a publication shows the Publishing pill at once in
  the top bar (dashboard and Studio) and a Publishing row in the Studio rail,
  with the queue position, the running stage or "finishing" after the pointer
  flips. It pulses, updates from publication events and polls, links to Review,
  and clears when the release is live or the publication fails.

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

No unit tests are added for Studio. On 2026-10-13 the published collection was
checked with local synthetic browser fixtures at desktop and 390 px phone width,
including JSON/SSE reads, search, copy, absent exports, custom bundles,
unpublished systems, retry and switching systems during a pending read. On
2026-10-16 the Deliverables view and client handoff were checked the same way
after the developer handoff moved to the CLI at `@latest`. These
local checks do not establish deployed behavior. Browser acceptance must use
the real deployed host and a disposable source; this file does not claim that
acceptance has passed.
