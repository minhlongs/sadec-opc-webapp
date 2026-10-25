import { defineConfig } from 'vitest/config';

/**
 * The app's own tests only. This repo also carries the engineer kit under
 * `.claude/`, whose scripts have their own test files; collecting them would
 * make `pnpm test` report on code this app does not own, and would let a failure
 * somewhere in the kit look like a product failure.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', '.claude/**', 'dist/**'],
    reporters: 'default',
  },
});
