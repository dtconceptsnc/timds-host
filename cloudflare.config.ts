import { defineConfig } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

export default defineConfig({
  worker: {
    name: 'timds-host',
    compatibilityDate: '2026-10-12',
    compatibilityFlags: ['nodejs_compat', 'enable_ctx_exports'],
    entrypoint,
  },
});
