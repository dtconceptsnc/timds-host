import { defineConfig } from 'cf/config';

// Replace this disposable name before creating resources. Keep it identical on both branches.
export default defineConfig({ worker: {
  name: 'timds-host-preview-spike-example',
  compatibilityDate: '2026-10-06',
  assets: { htmlHandling: 'auto-trailing-slash' },
} });
