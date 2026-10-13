# conformance/ for agents

Supplements the root [`AGENTS.md`](../AGENTS.md). [`README.md`](README.md) is the
specification for this package.

- This is a separate npm package with its own lockfile. Install with
  `npm ci --ignore-scripts` here, not from the root.
- `npm test` runs the harness's own unit tests against the vendored contract
  at `../docs/api/timds-host.openapi.json`. It is safe and needs no host.
- `npm run test:host` performs real edits, publications, rollback and a
  designer Request on whatever `TIMDS_HOST_URL` and fixture it is given. Never
  run it unless the person you are working with supplied a disposable fixture
  and asked for the run in this conversation; see `README.md` for the fixture
  rules and `../docs/ci.md` for the GitHub Actions dispatch.
- The toolkit pin `@dtconcepts/timds@0.1.464` is the conformance baseline. Do
  not bump it as part of another change.
- Contract changes are additive. Change the OpenAPI file, the harness, and the
  document that explains the route together.
