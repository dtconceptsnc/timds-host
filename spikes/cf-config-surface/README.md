# Configuration-only probe

This fixture checks `cf@1.0.0-beta.14` Workflow exports/self-bindings, OAuth KV,
static assets, R2, and two fixed Artifacts namespaces. It contains no host domain
behavior and was never deployed.

```sh
npm ci
npm run typecheck
npm run dry-run
```

Both commands passed on 2026-10-13. The latter builds and validates without
provisioning or uploading. Keep `--dry-run`: these placeholder names exist only
to check configuration.

[Findings and exact R2/provisioning snippets](../../docs/evidence/cf-config-surface.md).
