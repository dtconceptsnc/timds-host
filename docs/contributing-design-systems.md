# Contribute to a Design System

Studio, the TimDS CLI and remote MCP share the same hosted sessions, drafts,
submissions and publication history. Choose the interface that fits the work;
you can start in one and review or continue in another.

This guide is for an existing host and Design System. To install and provision
a host, follow the [operations runbook](operations.md). To change the host
software itself, follow [AGENTS.md](../AGENTS.md). Neither cloning this host
repository nor running a Cloudflare deployment is required to contribute to an
existing Design System.

## What you need

Ask the host operator for the authenticated host origin, your Design System's
immutable system ID, and access for your own identity. These examples use
`https://host.example.com` and `example/core`; replace them with the values your
operator supplies. Public published links belong to a separate public origin
and cannot be used for authenticated editing.

OAuth scopes and Design System permissions do different jobs:

| Permission | What it allows |
| --- | --- |
| OAuth `timds:read` | Use authenticated read tools and API routes within existing source/session authority. |
| OAuth `timds:write` | Use contribution and publication operations that the principal's source/session grants allow. |
| Source read/write grant | See or contribute to that Design System. OAuth consent does not create this grant. |
| Session membership | Work in an existing session after joining or being invited. It does not grant publication. |
| Publisher grant | Preflight, build-check, publish and roll back a source's releases. Write scope alone is insufficient. |

The session owner or a publisher can invite another eligible principal and
send a designer Request into an existing session. Any contributor may send a
Request that starts their own session. Host administrators manage source access;
a session invitation does not replace first-time source access onboarding. See
[source access invitations](access-invitations.md).

## Choose an interface

The lifecycle is shared; the controls reflect where the editing agent runs.
Remote MCP and local toolkit MCP have different tool names and transports.

| Work | Studio in a browser | CLI / local toolkit MCP | Remote host MCP |
| --- | --- | --- | --- |
| Connect | Browser OAuth sign-in | CLI OAuth login; stdio MCP uses saved host credentials | Client connects to HTTPS MCP URL and completes OAuth |
| Select a system | Sidebar | Explicit system ID or current hosted workspace | `list_systems`, `get_system` |
| Start/join/drafts | Open Studio, Start from a draft, Invite link | `start`, `join`, `draft`; `timds_*` tools | Session/draft tools and shareable Studio links |
| Edit | Send Requests to the hosted designer; Studio has no source editor | Agent edits local files, with toolkit MCP authored-path guards | Agent reads bounded files and submits revision-guarded changesets |
| Guide, workspace, media | The designer uses source rules | Toolkit editing guide, workspace, media and derived tools | Editing guide, workspace, media and checked-derived tools |
| Validate | Review Preview; publisher Build check only | `timds check`; local MCP `run_check` | `run_check`/`get_check` on a saved exact session snapshot; publisher `check_submission` |
| Preview | Embedded live session and frozen submission Preview | Local `dev`/`preview`; hosted URLs from status/submission | Live and frozen Preview URLs for the client to open |
| Submit | Hosted designer submits the Request | `submit` / `timds_submit` | `submit_session`, or designer Request completion |
| Publish | Explicit Publish dialog and stage strip | `publish` / `timds_publish`, with confirmation and status polling | Explicit preflight, check, publish and publication-poll tools |
| Roll back | Review release, then restore | CLI `rollback`; local MCP has no dedicated rollback tool in toolkit 0.1.476 | Rollback preflight and explicit guarded rollback |
| Live progress | Event feed, presence and Request stream | `status`, `history`, `active-work`; local MCP equivalents | `get_events`, `get_session`, `get_request`, `get_publication` polling |
| Close/disconnect | Close session; Disconnect clears this tab | `sessions close`; `auth logout` removes local credentials | Close tools; remove/disconnect the client's connection separately |

Large-media transfer and operator provisioning are separate APIs/workflows, not
ordinary source-file edits. Read media catalog entries in the editing tools and
use stable media keys in authored files. See [media operations](api/media.md)
for uploads, transfer capabilities and deletion.

## Set up Studio

1. Open `https://host.example.com/studio/` and sign in with your own identity.
   Follow the host's Access sign-in and OAuth consent screens.
2. Select the Design System from the sidebar. The Overview shows published
   releases, current work and the three contribution entry points.
3. Choose **Open Studio** to create a session, **Start from a draft…** to work
   toward a shared draft, or open an existing session. A Studio invite link
   includes the host and session; opening it signs in and joins as you.
4. Describe the change in the Request composer. Follow the designer's progress,
   live view and resulting submission. A queued Request may have earlier work
   ahead of it in the same session.

Studio is a steering console: agents write, people direct and review. It does
not expose source editing or a mine/theirs conflict picker. Use **Ask the agent
to resolve** for an existing conflict. The session rail shows submissions,
Preview links, people and close controls. See the [Studio specification](../studio/README.md)
for its views and live behaviour.

## Install and sign in to the CLI

Use Node.js 22.18+ and npm. The contributor examples pin toolkit `0.1.476`, the
version declared at this repository's root. The host's build/runtime and
conformance baseline deliberately stay on `0.1.464`; installing a contributor
CLI does not change a source's dependencies or those host pins.

```sh
npm install --global @dtconcepts/timds@0.1.476
timds auth login --portal-url https://host.example.com --oauth
timds auth status --portal-url https://host.example.com
timds whoami --portal-url https://host.example.com
```

For a one-off command, replace `timds` with
`npx --yes --package @dtconcepts/timds@0.1.476 timds`. The `--portal-url` option
takes the origin, not `/studio/` or `/api/timds/mcp`. Always provide the intended
origin before a workspace exists; `TIMDS_PORTAL_URL` also selects it. A started
workspace records its hosted provider origin.

The CLI opens a browser and waits for a temporary `127.0.0.1` OAuth callback.
With `--no-browser`, open the printed URL on the same machine; a remote shell
needs loopback forwarding. `--client-id` selects a pre-registered client when
required by the installation. The host supports OAuth, so keep `--oauth`; a
failed sign-in is not a reason to switch to a portal device flow.

The CLI requests `timds:read`, `timds:write` and `offline_access` by default
when advertised. For an explicitly read-only connection, use
`--scope 'timds:read offline_access'`. Use `--force` when replacing a saved
authorization with different scopes. Credentials are stored outside source
workspaces, keyed to their host origin. Refresh is serialized across CLI/MCP
processes; do not copy credentials into a source or MCP configuration.

## Connect a remote MCP client

The quickest route is Studio's **Send to your agent…** button, on the Design
System's Overview and in each session's Studio rail. Pick your client and it
gives you the one-time connect command or install link for that client, a
brief to paste into the agent that joins the session and submits for review,
and the `SKILL.md` the host serves through its `get_skill` tool. The
[Studio specification](../studio/README.md#agent-handoff) lists exactly what
it contains. By hand, choose your client's remote HTTP MCP connection and enter:

```text
https://host.example.com/api/timds/mcp
```

Complete the client's OAuth sign-in. The host's challenge asks for `timds:read`
and `timds:write`, so a client with no scope setting of its own arrives at the
consent page requesting both. The page lists each permission, where the
authorization will be sent, and says so when the client asked for read access
only. `offline_access` is optional if the client supports refresh. The client
must support OAuth authorization code with PKCE S256 and the host's advertised
client registration or a pre-registered client. Read-only consent omits
mutation tools; a client that connected read-only has to disconnect and connect
again to be asked for write access.

For a connection on `https://host.example.com`, the OAuth values are:

| Value | Endpoint |
| --- | --- |
| Authorization server metadata | `https://host.example.com/.well-known/oauth-authorization-server` |
| Protected resource metadata | `https://host.example.com/.well-known/oauth-protected-resource/api/timds` |
| Resource/audience | `https://host.example.com/api/timds` |
| Authorization | `https://host.example.com/authorize` |
| Token exchange | `https://host.example.com/token` |
| Dynamic client registration | `https://host.example.com/register` |

Let the client discover these values; the MCP URL is not the OAuth resource
value. If your operator supplies a separate configured Studio origin, connect
and authorize consistently on that origin. Tokens cannot be relabelled for
another hostname, scheme or port. The public origin's `/mcp` is an anonymous
published-guidance connection and does not expose hosted contribution tools.

A consumer that only reads a published system needs no sign-in. Point an
agent at the public root, `https://public.example.com/systems/example/core/`,
which serves the browsable guide, the derived documents beside the stamp
`.timds-artifact.json`, and `/v/<label>/` for immutable releases with
`/v/latest/` redirecting to the current one. The toolkit's
`timds mcp read --published <root>` serves the full consumer tool set
(`get_consumer_guide`, roles, brand, formats, designs, media) from those files
over stdio, and `/mcp` on the public origin answers the published read tools
over HTTP.

After connection, ask the agent to call `get_skill` for the intended system
and save the result at the path it names in its skills folder; from then on
every conversation knows how to work on that system. Then `list_systems`,
`get_system`, `get_active_work` and `get_editing_guide` as the skill says. A remote connection needs no local source checkout or local
toolkit MCP process. Tool schemas, byte limits and error receipts are in
[designer MCP](api/designer-mcp.md).

## Connect local toolkit MCP

Choose local stdio MCP when the agent should work in a directory on your
machine. Sign in with the CLI first. Configure your client's command, arguments
and environment with these values, substituting an absolute workspace path:

```json
{
  "command": "npx",
  "args": [
    "--yes", "--package", "@dtconcepts/timds@0.1.476",
    "timds", "mcp", "--root", "/absolute/path/to/design-session"
  ],
  "env": {
    "TIMDS_PORTAL_URL": "https://host.example.com"
  }
}
```

The surrounding configuration format depends on the MCP client. The equivalent
terminal launch is:

```sh
TIMDS_PORTAL_URL=https://host.example.com timds mcp --root ./design-session
```

Use an existing hosted session directory, or an empty destination where the
agent will call `timds_start` or `timds_join` before editing. The server stays
running on stdio; stdout is the protocol and progress goes to stderr. Local
tools include `get_editing_guide`, `describe_workspace`, guarded
`list_files`/`read_file`/`write_file`/`delete_file`, `run_check`, `read_derived`
and `list_media`, plus hosted `timds_*` lifecycle tools. Local file writes stay
on disk until `timds_update` or `timds_submit` sends them to the host.

The local consumer read server is a different mode:

```sh
timds mcp read --root ./design-session
timds mcp read --published https://public.example.com/systems/example/core/
```

That mode consumes derived/published guidance; it does not replace an editing
connection. Do not enable two agents to write the same local directory without
coordination. Separate hosted sessions provide isolated workspaces; shared
sessions use claims and revision checks to reveal concurrent work.

## Start, join and collaborate

For a new local session:

```sh
timds start example/core --root ./design-session --portal-url https://host.example.com
cd design-session
npm ci
timds active-work
timds claim --on 'tokens/color*' --note 'Improve the accent palette for contrast'
timds dev
```

`start` requires an empty destination and materializes source without a `.git`
directory. It saves a stable key during interrupted starts; retry the same
command. `npm ci` uses the source's existing lockfile. Inspect its `AGENTS.md`
and `README.md` before editing, and preserve its managed tooling/dependencies.

To join a session, copy **Invite… → Studio link** or use its session UUID:

```sh
timds join 'https://host.example.com/studio/#source=<source-uuid>&view=studio&session=<session-uuid>&join=1' --root ./joined-session
timds join '<session-uuid>' --root ./joined-session --portal-url https://host.example.com
```

These are alternatives, each using an empty destination. Toolkit 0.1.476 can
sign in to a pasted Studio link's host and choose a new session directory when
`--root` is omitted. The owner/publisher can list eligible identities with
`timds principals`, then invite one with
`timds join '<session-uuid>' --principal-id '<principal-uuid>'`.

Remote MCP uses `start_session` with a saved `idempotencyKey`, or
`join_session` as the authenticated caller. Use `list_principals` and
`invite_session_member` to invite an eligible principal; `get_session_link`
returns a Studio link. Membership does not grant source publication authority.

For shared draft work:

```sh
timds draft create spring-refresh --from main --system-id example/core --portal-url https://host.example.com
timds start example/core --draft spring-refresh --root ./draft-contribution --portal-url https://host.example.com
```

Remote MCP provides `create_draft`, `list_drafts`, draft file reads and
`start_session` with `draft`. Drafts have names and no expiry. Child submissions
integrate into their draft; the draft's own submission is the item published
to main. To edit/submit the draft itself, join its session. Claims communicate
intent and overlaps; they never lock paths.

## Edit, validate and submit

For local files, use the source's authored paths and keep notes under
`CHANGELOG.md` → `Unreleased` when the source has that contract. Do not edit
generated `dist/` output. Preview the change and run the source's checks:

```sh
timds check
timds preview
timds update --note 'Improve the accent palette for contrast'
timds submit --note 'Improve the accent palette for contrast'
```

`dev` is the authoring server; `preview` serves the built artifact. Stop a local
server with Ctrl-C when finished. `update` shares/reconciles working changes;
`submit` freezes a reviewable submission and Preview. Hosted submission does
not create a GitHub pull request and does not publish.

For remote MCP, read the workspace description and relevant source files,
declare intent with `claim_session`, and use `update_session` with full file
replacements/deletions against the exact `baseRevision` and `lastUpdateHash`.
Then call `run_check` with a new stable `checkId` and those snapshot guards,
and use `get_check` to retrieve the result. `read_derived` reads bounded checked
documents from that receipt. A later edit makes the earlier check stale; check
the current snapshot before submitting. `submit_session` uses the latest
snapshot guards and a note containing the user's instruction.

Alternatively, call `create_request` with a stable UUID and the instruction,
then poll `get_request`. Omit `sessionId` for a new session; targeting an
existing session/draft requires its owner or a publisher. Preserve the original
UUID, prompt and target on retry. A new follow-up instruction gets a new UUID.

Always inspect `stale`, `conflicts` and the actual submission receipt. Tool or
HTTP success alone does not mean a change was accepted. A frozen Preview can
still be building; wait until its status and URL are ready before reviewing
that exact submission. A session's live URL can show newer work and is not a
substitute for the frozen submission Preview.

## Review, publish and roll back

A publisher reviews the diff, intent and frozen Preview. Studio offers
preflight, **Build check only**, and an explicit **Publish release** action.
The CLI equivalents are:

```sh
timds publish --submission '<submission-uuid>' --dry-run
timds publish --submission '<submission-uuid>' --yes
```

Use `--yes` only after the user has approved that publication. Without it the
CLI requires confirmation. Remote MCP uses `preflight_submission`, optionally
`check_submission`, and an explicit `publish_submission` followed by
`get_publication`. A contributor's `run_check` validates a session snapshot;
publisher preflight/build checks also validate how the immutable submission
integrates with current main. Neither kind of check publishes.

Publishing enters the source's queue and follows preflight, merge, build,
prepare, release, flip and close. Keep the publication ID and follow its result;
request acceptance is not release completion. `closing` means the pointer has
committed and cleanup is still pending. Successful publication closes its
session. Inspect current/pinned release links and the final receipt. Reuse the
same submission when resuming a wait after an uncertain result; do not create a
replacement submission solely because publication polling was interrupted.

Rollback restores an already-published immutable version; it does not undo
session edits or rewrite release history. Review the selected version and
current pointer first. In Studio choose the release and confirm restore. In
the CLI:

```sh
timds rollback '<version-label>' --system-id example/core --dry-run
timds rollback '<version-label>' --system-id example/core --yes
```

Remote MCP uses rollback preflight and an explicit rollback operation bound to
the reviewed target and expected current version. Preserve its operation UUID
on uncertain retries. If the current release changed since review, reread and
review again instead of overwriting the newer pointer. Rollback needs the same
current publisher authority as publication.

## Conflicts, retries and recovery

When a shared session or its target changes, revision checks preserve the
competing work. Read the conflict's path/key and base/mine/theirs values. Studio
sends a follow-up Request to resolve it. A local agent can inspect the files,
run `timds update` to obtain the current conflict receipt, and then resolve:

```sh
timds update --resolve 'tokens/color.brand.json#600.value=theirs' --note 'Keep the reviewed accent from current main'
```

`--resolve PATH` keeps the local file; `PATH#KEY=mine|theirs` resolves one key.
The CLI binds choices to its saved `mainRevision`. Remote changesets carry
`resolvedPaths` and the exact `mainRevision` explicitly. Re-read/reapply after
stale results; do not copy an old revision into a new edit or silently choose a
side without the user's intended resolution.

Keep stable identities after an uncertain outcome: start/draft key, Request
UUID and original prompt/target, check UUID and snapshot, normalized submission
changeset, publication ID/submission, and rollback operation UUID. Separate
intent gets a new identity. See [submission recovery](submission-recovery.md)
and [publication recovery](publication-queue-recovery.md). A revoked grant or
archived source requires an operator to resolve the access problem, not a new
retry identity.

## Close and disconnect

When abandoning work or performing agreed cleanup, close it explicitly:

```sh
timds sessions close
timds draft close spring-refresh --system-id example/core
timds auth logout --portal-url https://host.example.com
```

Studio has a close control; remote MCP has `close_session` and `close_draft`.
The owner, publisher or existing operator authority must permit closing.
Closing a draft also closes its children. Open ordinary sessions expire after
24 hours; named drafts do not. Live containers can sleep after inactivity and
wake for viewers/Requests; sleeping is different from closed or expired.

Disconnecting a client does not close its sessions. Studio Disconnect clears
this tab's saved state; CLI logout removes that host's local credential without
revoking its server-side authorization. For remote MCP, disconnect/remove the
connection using the client's controls. Ask the operator about authorization
revocation or source-grant removal if access should end, rather than relying on
closing a browser tab.

## Troubleshooting and acceptance

| Symptom | Next step |
| --- | --- |
| No systems listed | Verify the signed-in identity and ask the operator for a grant on an active source; OAuth consent alone is insufficient. |
| Read tools work but mutations are absent | Reconnect with `timds:write`; inspect the client's granted scopes. |
| 403 on editing or publication | Confirm the current source/session grant or publisher grant. An administrator login is not a publisher grant. |
| Sign-in loops or invalid resource | Use the exact authenticated origin and `/api/timds` audience; do not connect to the public origin or reuse another origin's token. |
| CLI login waits indefinitely | Open its printed URL on the callback machine, arrange loopback forwarding, or retry with a suitable timeout; keep the same host origin. |
| Empty MCP workspace cannot edit | Start or join a hosted session first; local MCP needs its configured workspace and dependencies, remote MCP needs a valid session ID. |
| Protected path or unsafe file error | Edit authored source. Tooling, generated output and protected paths require a separately reviewed maintenance workflow. |
| Preview iframe is blocked | Use its open-in-new-tab link; ask the operator to verify Studio frame origins and Preview headers. |
| Stale check, update or submission | Reread the current snapshot, reconcile the intended edit and use fresh revision guards. |
| Request or publication remains queued | Inspect its queue position/status and existing receipt; avoid dispatching duplicate work. |
| Publication says closing | Follow the same publication while cleanup completes; the release pointer may already have moved. |

The remote implementation and local checks are not a deployed acceptance
claim. Validate client OAuth, permission failures, authored-path guards,
checks, draft integration, Preview readiness, publication, rollback and cleanup
on an explicitly authorized disposable source. Keep receipts outside this
public repository. The [verification guide](verification.md) and
[conformance package](../conformance/README.md) distinguish local checks from
live acceptance; no deployment or live fixture run is implied by this guide.
