import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

/**
 * The Worker build, Static Assets and the local D1 binding.
 *
 * `SADEC_D1_PERSIST` moves the local D1 state directory. The browser suite sets
 * it so its servers read and write a database of their own: the suite resets
 * that database on every run, and it must never be the one a developer has been
 * clicking through. With the variable unset, `pnpm dev` keeps the default
 * `.wrangler/state` exactly as before.
 */
const persistPath = process.env.SADEC_D1_PERSIST?.trim();

export default defineConfig({
  plugins: [cloudflare(persistPath === undefined || persistPath === '' ? {} : { persistState: { path: persistPath } })],
});
