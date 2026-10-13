# Native runtime extraction and offline build proof

Local implementation and image proof, October 13, 2026. The subsequent native
Cloudflare deployment is recorded in [deployment evidence](./phase-3-deployment.md).
Authenticated end-to-end host acceptance remains a separate gate.

The native runtime retains the portal's Git engine, binary tree transfer,
protocol-v2 main clone, exact Request completion identity/retry, live HMR policy,
and direct-push reconciliation. Repository capabilities enter only a trusted
outbound service and are revoked after an operation. Same-Worker callbacks use
`ctx.exports.SystemCoordinator`, bound to persisted source and session identity.
No host code executes repository programs during Git operations.

Repository trees cross native RPC as small immutable R2 references. A controlled
container endpoint streams bounded individual blobs to SNAPSHOTS; R2 validates
each supplied SHA-256 and size. The v1 API streams the original base64 JSON file
surface from those references. Ordinary repository operations have a ten-minute
deadline beneath their fifteen-minute session lease.

Publication uses native Workflow steps: preflight, merge, build, prepare,
release, flip, close. Each step claims and yields a durable lease. Source and
build receipts, frozen release date and stamped bytes survive retries. The
release stage reconstructs the same Git commit, copies and verifies immutable
physical RELEASES objects, then stages the version before pushing Git. The
coordinator commits the pointer atomically and public stamp verification follows;
a retry after that point repeats verification and cleanup without republishing.

Canonical release objects are `sources/<source UUID>/v/<version>/<artifact path>`
in RELEASES, with exact `.timds-artifact.json` bytes and a final
`.timds-release.json` manifest. Deployment must lock the bucket's `sources/`
prefix. Each put is conditional on absence, carries SHA-256, and checks existing
size/checksum before reuse. A different finalized label is refused. The manifest
is committed last and only a committed publication event exposes the release.
SNAPSHOTS source/build receipts remain internal.

The build image pins TimDS 0.1.464. Dependency installation allows only locked,
integrity-bearing registry.npmjs.org packages and runs `npm ci --ignore-scripts`.
The immutable dependency archive key includes exact package/lock bytes, image
identity, Node version/ABI, OS/architecture, toolkit version and install flags.
Each build restores the archive into a fresh container, revokes its narrow
archive read grant, denies network egress, and runs source checks as uid 1000.
Trusted image code validates the final regular-file artifact after terminating
source subprocesses. Build artifacts are bounded to 2,000 files and 80 MB.

## Actual image execution

Commands used the local image `timds-host-build-test:69`, built from
`runtime/Build.Dockerfile` with `--platform linux/amd64`. A fresh standalone
fixture initialized by the pinned toolkit installed its lock in that same Linux
image. Its 351 locked package entries passed the host registry/integrity policy;
`npm ci --ignore-scripts --no-audit --no-fund` installed 280 applicable packages.

The image then ran with Docker `--network none` and no credentials mounted:

```sh
node /opt/timds/build-driver.mjs validate-links
# Executed as the unprivileged node user in /work:
node /opt/timds/build-driver.mjs check
# Executed by the trusted controller after source exit:
node /opt/timds/build-driver.mjs manifest
```

The real check built 9 pages and 31 tokens, validated 7 token groups and 48
formats, and produced 40 regular artifact files totaling 405,382 bytes. The
trusted metadata command independently prepared version `2026.10.13-1` and its
four changed release files in a network-disabled image. Explicitly advanced
valid versions correctly return an empty change set.

Local `npm run typecheck` passed after native runtime and RELEASES wiring. No
new test files or cases are being added following the user's instruction to
prioritize real images, Cloudflare deployment, and CLI end-to-end acceptance.
