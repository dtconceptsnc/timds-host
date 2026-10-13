# runtime/ for agents

Supplements the root [`AGENTS.md`](../AGENTS.md).

- These modules run inside Cloudflare Containers built from `Dockerfile`
  (live sessions and the model agent), `Repository.Dockerfile` (trusted Git
  operations) and `Build.Dockerfile` (offline publication and dependency
  builds). `cloudflare.config.ts` binds each image to a Durable Object class.
- The Worker reaches a container only through the RPC classes exported from
  `index.mjs` and `build.mjs`. `policy.mjs` holds the outbound network policy;
  widening it is a security change and needs its architecture section updated.
- The container pins toolkit `0.1.464`; the root package pins `0.1.472` for
  the host. Keep them distinct and do not bump either as a side effect.
- Credentials given to a container are short-lived capabilities minted by the
  Worker. Never persist them, log them, or return them in an error.
- Tests for this directory live in `../test/runtime/`; `file-trees.test.mjs`,
  `live-dev.test.mjs`, `repository-engine.test.mjs` and `agent.test.mjs` are
  green, while `artifacts.test.mjs` and `repository-adapter.test.mjs` have
  known pre-existing failures (see the root guide).
- A Dockerfile change needs `npm run build` with Docker running.
