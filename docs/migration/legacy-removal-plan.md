# Portal runtime removal after source cutover

Prepared 2026-10-13 from the issue-69 portal worktree. This is a removal plan,
not a deletion receipt. No portal runtime file, service, source or stored byte
was removed. The accompanying symbol/import inventory (private operational record)
records 40 modules, their exports and direct non-test server importers at the
captured revision. Refresh that inventory at implementation time.

## Required cutover boundary

All four existing source identities must have verified terminal transfer state:
three live sources activated in the host with the exact imported pointers,
history and media; the deleted source retained as a deleted tombstone, never
revived. Capture the 12 public reads immediately before and after routing;
compare status, MIME and exact bytes, including expected 404s. Finish the
host's ordinary publication, Request, rollback and cleanup acceptance first.

Before disabling a legacy runner, verify every source is fenced, all old
session/publication jobs are terminal, write capabilities are revoked and the
new coordinator can resume retained intent IDs without executing old Requests
again. A source-local migration does not authorize stopping a shared service
while another source or website job still needs it. Preserve migration journals,
audit rows, provenance and locked release objects. Do not mass-delete Supabase
history, Docker volumes, local artifacts or service credentials.

## Remove the extracted authoring runtime

After their imports and routes are removed, these source-specific modules have
host replacements and are candidates for deletion:

| Portal files under `server/` | Replacement / removal condition |
| --- | --- |
| `design-system-sessions.mjs`, `design-system-session-repository.mjs`, `design-system-repository-rpc.mjs` | Host coordinator and RepositorySandbox; remove legacy start/pull/update/submit/claims/members/history/close handlers |
| `design-system-designer.mjs`, `design-system-designer-requests.mjs`, `design-system-live-sessions.mjs` | Native host Request queue and LiveSession; remove portal runner callbacks and dispatch |
| `design-system-submissions-admin.mjs`, `design-system-submission-publish.mjs`, `design-system-submission-publish-worker.mjs` | Host API and Workflow; the last file owns `buildDesignSystemSubmission` and the VPS Docker build |
| `design-system-publication-steps.mjs`, `design-system-publication-artifacts.mjs`, `design-system-submission-artifact.mjs`, `design-system-public-read.mjs` | Host Workflow, SNAPSHOTS and locked RELEASES; remove filesystem staging and portal publication uploads |
| `design-system-cli-publish.mjs`, `design-system-rollback.mjs` | Host publication/rollback API; split shared pure stamp validation first if retained consumer discovery still needs it |
| `design-system-source-sync.mjs`, `design-system-sync-scheduler.mjs`, `run-design-system-sync.mjs` | Remove source ingestion/autopublish; retain website consumer discovery through a separate read-only path |
| `run-design-system-session-cleanup.mjs` | Coordinator alarms own cleanup |
| `design-system-previews.mjs`, `design-system-artifacts-adapter.mjs` | Host owned Preview/Artifacts adapters; first remove old lifecycle and historical migration-tool dependencies |

In `server/repo-inspection-api.mjs`, remove the corresponding imports and
factories: `designSystemSessionRepository`, `designSystemSessions`,
`routeDesignSystemSessions`, `designSystemLiveSessions`, `designSystemDesigner`,
`designSystemDesignerRequests`, `designSystemSubmissionPublisher`,
`routeDesignSystemSubmissions`, `routeDesignSystemRollback` and source sync
scheduler. Delete `publishDesignSystemSubmissionArtifact`,
`expireDesignSystemSession`, `retryDesignSystemExecutionJob`,
`promoteDesignSystemVersion`, source-authoring branches of
`persistRepoDesignSystemDiscoveryUnlocked`, `handlePublishOperatorDesignSystem`,
`handleArchiveOperatorDesignSystem`, `handleSetOperatorDesignSystemAutoSync`
and `handleRunDueDesignSystemSyncs`. Remove their caller routes, including:

- `/api/internal/timds/designer/{complete,pushed,live-credentials,live-state,repository-control,expired}`
- `/api/internal/timds/designer/requests/:id/execute`
- `/api/internal/timds/publications/:id/execute`
- `/api/internal/timds/sessions/cleanup`
- legacy `/api/timds/publish`, source publication/rollback and source sync actions

Keep `routeTimdsHostPortal` and the human OAuth client. Retired write URLs must
return an explicit unsupported/moved response; never silently execute against
archived portal state. Remove `timds_designer_request` and
`publish_design_system_submission` dispatch branches in
`server/run-execution-jobs.mjs`. Remove `provision_design_system` and
`delete_design_system` from its lifecycle dispatch, while preserving
`provision_site` and unrelated Work Harness jobs.

## Split retained consumer features before deleting shared modules

| Shared surface | Required split |
| --- | --- |
| `design-system-lifecycle.mjs`, `design-system-lifecycle-adapters.mjs`, `design-system-lifecycle-worker.mjs` | Retain website preparation/confirmation, GitHub repository and Actions setup, canonical consumer links and `provision_site`. Remove DS `prepareProvision`, `prepareDelete`, DS repository cleanup and source provisioning stages. The worker's `generateLifecycleScaffold` currently runs Docker for both kinds; retaining website creation requires an independently supported website executor before retiring its image/service dependencies. |
| `design-system-lifecycle-cleanup.mjs`, `design-system-unused-worker.mjs` | Retire legacy DS deletion/resource sweep only after native deletion acceptance and terminal source intents; no broad storage cleanup. |
| `design-system-collaboration-store.mjs`, `design-system-authorization.mjs` | Extract portal catalogue/Client authorization and any website-lifecycle reads. Remove session/publisher/publication authority; host D1/DO owns it. Portal OAuth forwarding must retain fresh human and source-read checks. |
| `design-system-admin.mjs` | Keep catalogue validation/list/get/update; replace source runtime actions with existing host client. Remove `createDesignSystemReadTokenAction` after no portal Git capability is needed. |
| `design-system-drafts.mjs`, `timds-draft-runner.mjs`, `design-system-draft-read.mjs` | Remove former authoring MCP proxy, runner Git worktrees and Docker execution. First extract `isUuid`, archive validation/limits and viewer constants imported by consumer previews/read MCP. Host-owned private draft reads must use a real host-authorized identity or fail closed, never a stale portal session. |
| `design-system-artifacts.mjs`, `design-system-artifact-uploads.mjs`, `design-system-assets.mjs` | Separate consumer preview storage, public media and read utilities from source publication writers. Consumer previews currently call `writeDesignSystemArtifact`; deleting the whole module breaks website review. |
| `design-system-core.mjs`, `design-system-consumer-link.mjs` | Retain published-bundle consumer discovery and stable source identity linking. Remove direct source ingestion/publish behavior. |
| `design-system-read-mcp.mjs` | Preserve portal Client-bound tokens/external identity and gap Requests. For migrated sources read current pointer and documents from host R2 authority; do not serve imported Supabase pointers/local files as current truth. |
| `design-system-public-roots.mjs`, `design-system-public-worker.mjs`, `configure-design-system-public-roots.mjs` | Retire old root proxy/reconciliation only after domains route to the companion and byte acceptance passes. Extract read-only release selection still used by consumer linking/site pinning, then replace it with host authority. |

`design-system-consumer-previews.mjs`, `design-system-consumer-review.mjs`,
`site-actions-provisioning.mjs`, `import-design-system-site.mjs`, catalogue
metadata, Client/Project context and canonical consumer relationships remain
portal responsibilities. Their database triggers and review gates remain.
General Work Harness GitHub operations and unrelated Docker prototype services
are outside this extraction; a repository-wide deletion of `git`, `spawn` or
Docker references would remove unrelated products.

## Runtime and operational retirement

Disable and remove the TimDS-specific `portal-design-system-sync` and
`portal-design-system-session-cleanup` service/timer pairs after terminal-job
verification. Remove the `portal-design-system-roots` pair after public routing
and reconciliation ownership move. Retire `timds-draft-runner.service`,
`timds-draft-prune.service`, `cloudflared-timds-draft-runner.service`,
`ops/install-timds-draft-runner.sh` and `ops/timds-draft-build/` only when the
retained website executor no longer uses that image/runtime. Remove matching
package scripts (`design-system-sync:run`, `timds-draft-runner:run`,
`design-system-roots:configure`) and obsolete runtime env documentation.
Do not stop or remove unrelated `dt-work-prototype-stack.service` or generic
portal/execution-job services.

The duplicate `cloudflare/timds-designer/` source and deployment configuration
can leave the portal repository after the native host image/runtime is accepted
and all old callbacks are unreachable. Retire only its explicitly inventoried
owned resources; another agent's #60 sessions must finish under its ownership.

Keep `timds-source-ownership.mjs`, `transfer-timds-source.mjs`,
`timds-transfer-export.mjs`, `timds-transfer-probes.mjs`, OAuth storage/client,
consumer fence/proof, migration SQL and receipts. The probes legitimately use
read-only Git/process inspection to attest an old deployment; that is not an
active authoring path. The older `migrate-design-system-artifacts.mjs` is a
different GitHub-to-Artifacts migration with Git/Docker writes: archive/remove
its executable implementation once its own historical operations are terminal,
without removing the new ownership transfer driver.

Update `TIMDS_GITLESS.md`, `DESIGN_SYSTEMS.md`, `FINAL_PRD.md`, `PRD_CURRENT.md`
and `supabase/README.md` in the final removal change. Keep a concrete record of
what was stopped/deleted and what remains for consumer features. Verification
is syntax/typecheck/build plus actual host, portal and public-read journeys;
no new tests are requested.
