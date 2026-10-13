import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
export default defineConfig({ server: { host: '127.0.0.1', port: 8796, strictPort: true }, plugins: [cloudflare()] });
