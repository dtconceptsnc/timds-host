# Frozen submission Previews

`createPreviews({env, fetchImpl})` returns `ensure(source)`, `url(source, branch)`,
`remove(source, branch)` and `deleteSourcePreview(source)`. Setup retains the
portal's source-owned Worker marker and exact Artifacts namespace/repository ID
checks. Commands are `npm run build:preview`, `npx cf deploy` and
`npx cf previews deploy`. Credentials come only from server configuration.

## Static Preview performance

For sources whose reviewed `vite.config.mjs` only packages the already-built
`dist` through the Cloudflare plugin, the controller also accepts this Preview
deploy command:

```sh
CLOUDFLARE_PREVIEW_BUILD=true npx vite build && npx cf previews deploy --prebuilt
```

Normally keep the build command `npm run build:preview`. It runs the full source
build and TimDS checks. For a separately reviewed source where `npm run build`
already includes the exact workspace check (for example, `astro check && astro
build` with a workspace check of `astro check`), this paired build command
avoids running the same check twice:

```sh
npm run build && npm run timds -- check --skip-build
```

`--skip-build` skips both workspace commands, so this profile must be reviewed
again if the source's scripts or workspace contract change. It still runs the
TimDS artifact, token/media, designs, bundle and video validations. The
controller only accepts it paired with the static Preview deploy command.

Packaging runs afterward, so the final derived files enter
the asset output. The pinned Cloudflare Vite plugin uses
`CLOUDFLARE_PREVIEW_BUILD=true` to emit Preview Build Output; deploying ordinary
production output with `--prebuilt` remains invalid. This avoids `cf` detecting
Astro and building the source a second time during deployment.

This is an opt-in setting after inspecting the source's Vite configuration;
do not apply it to arbitrary framework/SSR sources. Deploy the controller
support before changing a source's `previews_base_config`, or the older host
will reject setup. An individual existing Preview can be benchmarked without
changing that parent template. Production commands remain unchanged.

Keep caching disabled until measuring it on the actual source. The representative
2026-10-13 benchmark took 93 seconds without caching and 115 seconds with a populated
cache: restoring the dependency cache took 18 seconds and npm still installed
packages afterward. The experiment was reverted. Cache support alone does not
establish a speed improvement.

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
