# Smoke suite

`npm test` runs every `*.test.mjs` here with Node's built-in runner. It is a
high-level smoke suite, not a unit-test suite, and the repository does not
want one. [`AGENTS.md`](../AGENTS.md) "Which checks mean what" and "Conventions"
are the contract; this note repeats it where tests are written.

- A test proves that the code loads and that one end-to-end, in-process path
  works: a request in, a response or stored row out. The current files cover
  module loading, migrations and catalog bootstrap, Access tokens, public
  serving and the public MCP server.
- Do not add tests for individual functions, helpers or branches, and do not
  add a mocking or assertion library. Tests construct real modules through
  their factories and inject small D1-shaped adapters over `node:sqlite`
  (see [`catalog.test.mjs`](catalog.test.mjs)); `public-fixture.mjs` is the
  shared fixture for the public surface.
- Keep the suite fast and green. If a check needs a deployed host, it is
  acceptance, not a test here: see [`docs/verification.md`](../docs/verification.md)
  and the [conformance package](../conformance/README.md).
