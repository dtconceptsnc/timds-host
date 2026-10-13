import { bindings, defineConfig, defineContainer, exports, triggers } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

const name = process.env.TIMDS_SPIKE_NAME;
if (!name || !/^timds-host-spike-[a-z0-9-]{1,32}$/.test(name)) {
  throw new Error('Set TIMDS_SPIKE_NAME to a unique disposable name: timds-host-spike-<suffix>');
}
const sandbox = defineContainer({
  name: `${name}-sandbox`,
  schedulingPolicy: 'durable-object',
  images: { git: { dockerfile: './Dockerfile' } },
});
export default defineConfig({
  worker: {
    name,
    compatibilityDate: '2026-10-06',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    exports: { RepositorySandbox: exports.durableObject({ storage: 'sqlite', container: sandbox }) },
    env: {
      DB: bindings.d1({ name }),
      RELEASES: bindings.r2({ name }),
      PUSHES: bindings.queue({ name }),
      REPOS: bindings.artifacts({ namespace: name, dev: { remote: true } }),
      PROBE_TOKEN: bindings.secret(),
    },
    triggers: [triggers.queue({ name, maxBatchSize: 1, maxBatchTimeout: 0 })],
  },
  containers: [sandbox],
});
