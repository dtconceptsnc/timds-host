# Frozen submission Previews

`createPreviews({env, fetchImpl})` returns `ensure(source)`, `url(source, branch)`,
`remove(source, branch)` and `deleteSourcePreview(source)`. Setup retains the
portal's source-owned Worker marker and exact Artifacts namespace/repository ID
checks. Commands are `npm run build:preview`, `npx cf deploy` and
`npx cf previews deploy`. Credentials come only from server configuration.

The [live cf proof](../../docs/evidence/cf-preview-builds.md) established that
creation can acknowledge `previews_enabled:true` but return a disabled legacy
trigger. The adapter migrates only an owned, matching connection with the
expected production settings, then rereads the configuration before accepting
readiness. Named Preview deletion uses the verified Workers API operation;
there is no Node process or Wrangler fallback. Source deletion refuses a
repository connection shared with any other Worker and never deletes the
operator's shared deployment token.

`parsePreviewBuildEvent` accepts the observed successful event shape and yields
the source UUID for Queue routing. `createPreviewBuildHandler` then checks the
current source, frozen submission branch and exact commit. It verifies owned
Worker/Builds metadata, separately fetches the actual Preview listing and
account subdomain, and requires an anonymous HTML response. Queue payloads
never provide a trusted URL. The injected `recordPreviewBuild` performs a final
atomic source/branch/head/status check and deduplicates the build ID. It only
records Preview readiness; it cannot move a public pointer or publish a release.

The controller requires prepared `cf` configuration and a real npm lockfile.
`prepareCfPreviewFiles(files,{workerName})` creates a reviewable conversion of
the known toolkit `.464` hosted standalone scaffold. The companion
`scripts/prepare-preview-source.mjs` defaults to a plan; explicit `--apply`
installs exact pins, runs the unchanged toolkit build/check, builds through cf,
and compares every output path and byte. The [actual deployment proof](../../docs/evidence/cf-preview-source.md)
verified all 40 servable files anonymously. Existing framework configurations
and custom legacy bindings require separate review; imported sources are never
rewritten by the controller.

Run local adapter/correlation tests with:

```sh
node --test test/preview/*.test.mjs
```

These tests do not replace full standalone host conformance in `cf dev` and a
deployed environment.
