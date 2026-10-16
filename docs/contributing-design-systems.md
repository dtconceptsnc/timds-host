# Contribute to a Design System

Studio and the TimDS CLI share the same hosted sessions, drafts, submissions
and publication history. Choose the interface that fits the work; you can
start in one and review or continue in the other.

This guide is for an existing host and Design System. To install and provision
a host, follow the [operations runbook](operations.md). To change the host
software itself, follow [AGENTS.md](../AGENTS.md). Neither cloning this host
repository nor running a Cloudflare deployment is required to contribute to an
existing Design System. Building a product *from* a published system is a
different job; start at [consuming a published system](consuming/README.md)
for that.

## What you need

Ask the host operator for the authenticated host origin, your Design System's
immutable system ID, and access for your own identity. These examples use
`https://host.example.com` and `example/core`; replace them with the values your
operator supplies. Public published links belong to a separate public origin
and cannot be used for authenticated editing.

OAuth scopes and Design System permissions do different jobs:

| Permission | What it allows |
| --- | --- |
| OAuth `timds:read` | Use authenticated read commands and API routes within existing source/session authority. |
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

The lifecycle is shared; the controls reflect where the editing agent runs. In
Studio the hosted designer edits; with the CLI, you or your own agent edit a
local copy of the source.

| Work | Studio in a browser | TimDS CLI |
| --- | --- | --- |
| Connect | Browser OAuth sign-in | `timds auth login --oauth` |
| Select a system | Sidebar | Explicit system ID or the current hosted workspace |
| Start/join/drafts | Open Studio, Start from a draft, Invite link | `start`, `join`, `draft` |
| Edit | Send Requests to the hosted designer; Studio has no source editor | Edit local authored files; the toolkit guards protected paths |
| Validate | Review Preview; publisher Build check only | `timds check` |
| Preview | Embedded live session and frozen submission Preview | Local `dev`/`preview`; hosted URLs from `status` and the submission receipt |
| Submit | Hosted designer submits the Request | `submit` |
| Publish | Explicit Publish dialog and stage strip | `publish`, with confirmation and status polling |
| Roll back | Review release, then restore | `rollback` |
| Live progress | Event feed, presence and Request stream | `status`, `history`, `active-work` |
| Close/disconnect | Close session; Disconnect clears this tab | `sessions close`; `auth logout` removes local credentials |

Large-media transfer and operator provisioning are separate APIs/workflows, not
ordinary source-file edits. Read media catalog entries with `timds assets list`
and use stable media keys in authored files. See [media operations](api/media.md)
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

The CLI is the npm package
[`@dtconcepts/timds`](https://www.npmjs.com/package/@dtconcepts/timds). Use
Node.js 22.18+ and npm, and run it at `@latest` so you always have the current
toolkit and never maintain a version yourself:

```sh
npm install --global @dtconcepts/timds@latest
timds auth login --portal-url https://host.example.com --oauth
timds auth status --portal-url https://host.example.com
timds whoami --portal-url https://host.example.com
```

For a one-off command, replace `timds` with
`npx --yes @dtconcepts/timds@latest`. Installing the CLI does not change a
source's own dependencies; a started workspace keeps the toolkit its source
declares, and `npm ci` inside it installs that copy.

The `--portal-url` option takes the origin, not `/studio/`. Always provide the
intended origin before a workspace exists; `TIMDS_PORTAL_URL` also selects it.
A started workspace records its hosted provider origin.

The CLI opens a browser and waits for a temporary `127.0.0.1` OAuth callback.
With `--no-browser`, open the printed URL on the same machine; a remote shell
needs loopback forwarding. `--client-id` selects a pre-registered client when
required by the installation. The host supports OAuth, so keep `--oauth`; a
failed sign-in is not a reason to switch to a portal device flow.

The CLI requests `timds:read`, `timds:write` and `offline_access` by default
when advertised. For an explicitly read-only connection, use
`--scope 'timds:read offline_access'`. Use `--force` when replacing a saved
authorization with different scopes. Credentials are stored outside source
workspaces, keyed to their host origin. Refresh is serialized across CLI
processes; do not copy credentials into a source or any other configuration.

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
If your own coding agent does the editing, point it at the started workspace
and the same CLI commands; the source's `AGENTS.md` tells it the rules.

To join a session, copy **Invite… → Studio link** or use its session UUID:

```sh
timds join 'https://host.example.com/studio/#source=<source-uuid>&view=studio&session=<session-uuid>&join=1' --root ./joined-session
timds join '<session-uuid>' --root ./joined-session --portal-url https://host.example.com
```

These are alternatives, each using an empty destination. The CLI can sign in
to a pasted Studio link's host and chooses a new session directory when
`--root` is omitted. The owner/publisher can list eligible identities with
`timds principals`, then invite one with
`timds join '<session-uuid>' --principal-id '<principal-uuid>'`. Membership
does not grant source publication authority.

For shared draft work:

```sh
timds draft create spring-refresh --from main --system-id example/core --portal-url https://host.example.com
timds start example/core --draft spring-refresh --root ./draft-contribution --portal-url https://host.example.com
```

`timds draft list` shows a system's drafts. Drafts have names and no expiry.
Child submissions integrate into their draft; the draft's own submission is
the item published to main. To edit/submit the draft itself, join its session.
Claims communicate intent and overlaps; they never lock paths.

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
not create a GitHub pull request and does not publish. `timds status` and
`timds history` show the session's current state and what has been shared;
`timds pull` brings the session's newer work into the local copy.

Always inspect `stale`, `conflicts` and the actual submission receipt. Command
success alone does not mean a change was accepted: a conflicting `update`
lists the conflicts and keeps the local files, and a stale or conflicting
`submit` prints its receipt and exits non-zero. A frozen Preview can still be
building; wait until its status and URL are ready before reviewing that exact
submission. A session's live URL can show newer work and is not a
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
CLI requires confirmation. A contributor's `timds check` validates the local
working copy; publisher preflight/build checks also validate how the immutable
submission integrates with current main. Neither kind of check publishes.

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

If the current release changed since review, reread and review again instead
of overwriting the newer pointer. Rollback needs the same current publisher
authority as publication.

## Conflicts, retries and recovery

When a shared session or its target changes, revision checks preserve the
competing work. Read the conflict's path/key and base/mine/theirs values. Studio
sends a follow-up Request to resolve it. Locally, inspect the files, run
`timds update` to obtain the current conflict receipt, and then resolve:

```sh
timds update --resolve 'tokens/color.brand.json#600.value=theirs' --note 'Keep the reviewed accent from current main'
```

`--resolve PATH` keeps the local file; `PATH#KEY=mine|theirs` resolves one key.
The CLI binds choices to its saved `mainRevision`. Re-read/reapply after stale
results; do not copy an old revision into a new edit or silently choose a side
without the user's intended resolution.

Keep stable identities after an uncertain outcome: start/draft key, Request
UUID and original prompt/target, normalized submission changeset, publication
ID/submission, and rollback version. Separate intent gets a new identity. See
[submission recovery](submission-recovery.md) and
[publication recovery](publication-queue-recovery.md). A revoked grant or
archived source requires an operator to resolve the access problem, not a new
retry.

## Close and disconnect

When abandoning work or performing agreed cleanup, close it explicitly:

```sh
timds sessions close
timds draft close spring-refresh --system-id example/core
timds auth logout --portal-url https://host.example.com
```

Studio has a close control. The owner, publisher or existing operator
authority must permit closing. Closing a draft also closes its children. Open
ordinary sessions expire after 24 hours; named drafts do not. Live containers
can sleep after inactivity and wake for viewers/Requests; sleeping is different
from closed or expired.

Signing out does not close your sessions. Studio Disconnect clears this tab's
saved state; CLI logout removes that host's local credential without revoking
its server-side authorization. Ask the operator about authorization revocation
or source-grant removal if access should end, rather than relying on closing a
browser tab.

## Troubleshooting and acceptance

| Symptom | Next step |
| --- | --- |
| No systems listed | Verify the signed-in identity and ask the operator for a grant on an active source; OAuth consent alone is insufficient. |
| Reads work but edits and publication are refused | Sign in again with `timds auth login --oauth --force` and accept `timds:write` on the consent page. |
| 403 on editing or publication | Confirm the current source/session grant or publisher grant. An administrator login is not a publisher grant. |
| Sign-in loops or invalid resource | Use the exact authenticated origin; do not sign in on the public origin or reuse another origin's credential. |
| CLI login waits indefinitely | Open its printed URL on the callback machine, arrange loopback forwarding, or retry with a suitable timeout; keep the same host origin. |
| Workspace commands refuse to run | Start or join a hosted session first; a workspace needs its recorded host origin and `npm ci` before `check`, `dev` and `preview`. |
| Protected path or unsafe file error | Edit authored source. Tooling, generated output and protected paths require a separately reviewed maintenance workflow. |
| Preview iframe is blocked | Use its open-in-new-tab link; ask the operator to verify Studio frame origins and Preview headers. |
| Stale check, update or submission | Reread the current snapshot, reconcile the intended edit and use fresh revision guards. |
| Request or publication remains queued | Inspect its queue position/status and existing receipt; avoid dispatching duplicate work. |
| Publication says closing | Follow the same publication while cleanup completes; the release pointer may already have moved. |

The host implementation and local checks are not a deployed acceptance claim.
Validate client OAuth, permission failures, authored-path guards, checks, draft
integration, Preview readiness, publication, rollback and cleanup on an
explicitly authorized disposable source. Keep receipts outside this public
repository. The [verification guide](verification.md) and
[conformance package](../conformance/README.md) distinguish local checks from
live acceptance; no deployment or live fixture run is implied by this guide.
