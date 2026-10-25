import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

/**
 * The Cloudflare plugin wires the Worker build, Static Assets and the local D1
 * binding, so this file stays small. Test settings live in vitest.config.ts —
 * Vite does not read a `test` key here.
 */
export default defineConfig({
  plugins: [cloudflare()],
});
