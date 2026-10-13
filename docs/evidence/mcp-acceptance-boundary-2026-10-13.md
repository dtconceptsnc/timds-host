# MCP acceptance boundary — 2026-10-13

Actual authenticated SDK calls to the remote host MCP listed tools and read
current tokens using the staff human's existing normal OAuth grant. Anonymous
API access returned the protected-resource discovery challenge. The
[sanitized receipt](authenticated-mcp-read.json) and
[media acceptance](native-media-acceptance.md) record those checks.

At `17:42:52Z`, a Codex-driven MCP SDK stdio client launched the actual released
`@dtconcepts/timds@0.1.472` CLI as `timds mcp --root <empty temporary workspace>`.
`TIMDS_PORTAL_URL` selected the current host and a temporary XDG config symlink
let the toolkit resolve the existing normal staff OAuth grant without copying
or passing a bearer token. The server identified itself as
`timds-design-system` version `0.1.472`, listed 23 tools including the guarded
editing and hosted start/submit/publish tools, and successfully executed
`timds_active_work` for disposable source
`911d25de-0cc4-4406-a38f-80d2f44f462d`. Its authenticated response returned the
same source ID, API version 1 and `canPublish: true`. The client exited and the
temporary workspace/config symlink were removed. This took about 1.7 seconds;
no host session, source or publication was mutated. See the
[sanitized local MCP receipt](local-mcp-read-acceptance.json).

This does **not** establish a fresh CIMD authorization flow, an interactive
Claude Code client, or local editing MCP start/submit/publish acceptance. CIMD
is enabled and advertised by `src/auth/oauth.mjs`; metadata/configuration is not
an executed client authorization. The released toolkit CLI's normal OAuth and
publication acceptance are separate evidence. Additional MCP publication and
UI coverage were skipped when the user prioritized production cutover.

The existing interfaces have deliberately different purposes:

- Released `@dtconcepts/timds@0.1.472` local `timds mcp` registers guarded editing
  and hosted `timds_start`, `timds_submit`, `timds_publish`, and session tools.
  They call the same versioned host API with the caller's OAuth identity and
  per-source publisher grant. No new remote authoring tools are needed to use
  this existing path.
- Host remote `/api/timds/mcp` serves published reads. With write scope,
  `report_gap` submits a native designer Request; its stable identity includes
  source, caller, immutable release, and gap content. It does not itself publish.
  Actual `report_gap` write/replay acceptance is not claimed by the read receipt.
- The retained portal consumer MCP's `report_gap` keeps its Client-scoped
  portal Request/Approvals intake. It does not impersonate a host principal or
  directly start a host designer. This is distinct from the host endpoint.

The issue's literal OAuth-authenticated MCP authoring criterion must therefore
be assessed against the local toolkit path, and its CIMD criterion against a
fresh remote MCP authorization. The executed local stdio OAuth read establishes
transport, discovery, existing-grant resolution and authenticated host access;
it must not be relabelled as a complete authoring journey. CLI OAuth or
public/previously authenticated reads likewise do not establish fresh CIMD.
