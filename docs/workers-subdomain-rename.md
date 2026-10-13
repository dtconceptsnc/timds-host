# Workers account subdomain rename

After an account subdomain rename, deploy the API/public Workers with their new
origins and update OAuth/Access and the portal's trusted host/public origins.
Existing ephemeral Live and submission Preview Workers retain their names under
the account's new subdomain. Newly generated URLs already use the provider's
current `/workers/subdomain` value.

For active rows whose saved URLs predate the rename, configure
`TIMDS_WORKERS_SUBDOMAIN_ALIASES` as a JSON object of explicit former to current
account labels, for example `{"former-label":"current-label"}`. The default `{}`
disables projection. Labels must be valid DNS labels; chains/cycles are rejected.
Deploy configuration must expose this variable as a text binding.

The authenticated HTTP and coordinator API boundaries project only active session `liveUrl` and
active submission `previewUrl` fields, including their list and preflight DTOs.
It requires HTTPS, no credentials or nondefault port, and the exact Worker name
derived from the source/session identities or the stored review branch. Paths,
queries and fragments remain intact. Unrelated hosts are unchanged.
The HTTP projection also handles replies from a coordinator still finishing work
on the previous deployment; no Durable Object restart is needed.

This is a response projection: source manifests, durable rows, immutable review
branches, publication receipts, audit events, source files and snapshot bytes are
unchanged. Closed/published submission history is unchanged. It does not acquire
a session lease or resume, recreate, publish or reconcile work. Consumers of
historical URLs may still see the former hostname. A retained source's
`timds.json` provider URL requires a separate normal owned edit; this projection
does not silently modify its Git history.

After deployment, read the original session's `/status` endpoint and source
`/submissions` endpoint using its human OAuth grant. Confirm unchanged identity,
head and review branch alongside the projected URLs, then open the active Live
and Preview URLs and inspect Studio. Keep prior receipts as historical evidence.

Actual acceptance on 2026-10-13 at 17:06:51Z returned HTTP 200 from both the
original manual session's metadata-only status and its source submission list.
Both active URLs used the new `<subdomain>.workers.dev` domain. The original submission
ID, review branch, original base and immutable review head stayed unchanged;
the later saved fork revision also remained intact. See the
sanitized receipt (private operational record). This receipt verifies
API identity and URL projection; browser rendering is separate acceptance.
