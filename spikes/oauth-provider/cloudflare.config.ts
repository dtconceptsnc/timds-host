import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// Local workerd interoperability fixture. Do not deploy this synthetic identity handler.
export default defineConfig({
  worker: {
    name: 'timds-local-oauth-provider-spike',
    compatibilityDate: '2026-10-12',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    env: { OAUTH_KV: bindings.kv() },
  },
});
