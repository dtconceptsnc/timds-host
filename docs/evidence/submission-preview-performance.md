# Submission Preview performance

Measured October 13, 2026 against the same submitted revision of a representative
static Astro design system. Source and deployment identifiers are omitted.
These are Workers Builds creation-to-completion
durations, not total time from starting a designer Request or clicking Submit.
The [sanitized receipt](submission-preview-performance.json) includes stage timings and public-file hashes.

| Configuration | Total | Build command | Deploy command | Astro checks/builds |
| --- | ---: | ---: | ---: | ---: |
| Original, cache disabled | 93.1 s | 46.8 s | 13.7 s | 2 / 2 |
| Cache warmup | 106.1 s | 31.2 s | 9.2 s | 2 / 2 |
| Populated cache | 114.8 s | 53.4 s | 12.8 s | 2 / 2 |
| Direct static packaging | 100.5 s | 52.3 s | 11.5 s | 2 / 1 |
| One check, direct static packaging | 72.7 s | 33.8 s | 6.6 s | 1 / 1 |

The final run was 21.9% shorter than the baseline. These are individual runs;
runner/installation time varies, so this is not a guaranteed speedup. All runs
completed successfully. Dependency cache restoration added about 18 seconds
and still required npm installation; caching was restored to disabled.

The submitted source was read from Artifacts at the exact commit. Its
`workspace.build` is `npm run build`, whose script is `astro check && astro
build`. Its `workspace.check` is `npm run check`, whose script is `astro check`.
The optimized build runs the original build once, then TimDS validation with
`--skip-build` to avoid repeating that same check. The submitted Vite config
copies `dist` through the Cloudflare plugin; the optimized deploy packages the
final validated output in Preview context before `cf previews deploy --prebuilt`.

The existing Preview's final settings are:

```json
{
  "build_caching_enabled": false,
  "build_command": "npm run build && npm run timds -- check --skip-build",
  "deploy_command": "CLOUDFLARE_PREVIEW_BUILD=true npx vite build && npx cf previews deploy --prebuilt"
}
```

The foundation HTML page, tokens JSON and bundle manifest returned HTTP 200
and had identical SHA-256 hashes before and after both packaging changes.
This samples public output; it does not claim every output file was compared.

Seventeen Preview tests and `npm run typecheck` pass. Existing stale test
expectations were aligned with the already-implemented structured provider
diagnostics and manual redirect handling.

## Rollout state

Only the existing review Preview has the optimized settings. The parent
`previews_base_config` still uses the original commands, and production
settings are unchanged. Controller support is prepared locally but has not
been deployed: the previous controller rejects the optimized command pair.
Deploy that support before applying the pair to the source's parent Preview
template. Recheck source scripts before applying it to a different source or
a changed build contract. The workspace has unrelated pending host changes;
this experiment did not deploy them.
