# studio/ for agents

Supplements the root [`AGENTS.md`](../AGENTS.md). [`README.md`](README.md) is the
specification for this client; keep it in step with `app.js`.

- Three static files, no bundler, no framework, no build step. `vite.config.ts`
  serves this directory as `publicDir`; `src/studio.mjs` owns routing, the
  asset allowlist and security headers.
- Studio is a steering console: agents are the only writers. Do not add a file
  viewer, editor, or any call to the snapshot, `update`, `submit` or `claims`
  session routes.
- All API and WebSocket URLs derive from `location.origin`. Never read an
  origin from a server response, and never add inline styles or scripts; the
  CSP has no `unsafe-inline`.
- Rendered data goes through DOM text, not `innerHTML`.
- Phone width (390 px) is a supported layout: one column, 44 px tap targets,
  16 px inputs, no horizontal scroll.
- There are no unit tests here. Check syntax with `node --check studio/app.js`
  and describe browser acceptance as owed, not done, unless it was performed
  on a deployed host with a disposable source.
