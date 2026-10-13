import { bindings, defineConfig, exports } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

const workerName = 'timds-config-surface-spike';
const workflowName = `${workerName}-proof`;

export default defineConfig({
  worker: {
    name: workerName,
    compatibilityDate: '2026-10-12',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    entrypoint,
    exports: {
      ProofWorkflow: exports.workflow({
        name: workflowName,
        limits: { steps: 16 },
        concurrency: { limit: 2 },
        defaultRetention: { successRetention: '1 day', errorRetention: '7 days' },
      }),
    },
    env: {
      PROOF_WORKFLOW: bindings.workflow({ name: workflowName, worker: workerName, exportName: 'ProofWorkflow' }),
      // Omit id only when intentionally allowing deployment to provision a namespace.
      OAUTH_KV: bindings.kv(),
      ASSETS: bindings.assets(),
      OBJECTS: bindings.r2({ name: `${workerName}-objects` }),
      ORG_A_REPOS: bindings.artifacts({ namespace: `${workerName}-org-a`, dev: { remote: true } }),
      ORG_B_REPOS: bindings.artifacts({ namespace: `${workerName}-org-b`, dev: { remote: true } }),
    },
    assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*', '/oauth/*'] },
  },
});
