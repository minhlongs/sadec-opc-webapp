import { defineConfig } from '@playwright/test';

/**
 * The app's own browser tests, and only those.
 *
 * The repo carries the engineer kit under `.claude/`, which ships its own test
 * files. Without a testDir, `playwright test` picks up whatever matches its
 * default pattern anywhere in the tree — and on this machine a global `playwright`
 * package resolves first on PATH and runs the kit's suite instead, reporting a
 * green pass for tests that have nothing to do with this app. §15 cases 1, 2 and
 * 16 would then look verified when no browser ever opened.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/e2e',
  reporter: [['list']],
  use: {
    // Vietnamese first, and the desktop width from §5.
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    baseURL: 'http://localhost:5173',
  },
  webServer: {
    // One deterministic port for this project, so a second session finds the port
    // in use and reuses or stops it rather than starting a duplicate server on a
    // new port and leaving the first one running.
    command: 'pnpm exec vite --port 5173 --strictPort',
    port: 5173,
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      // §5 names 390px and 1440px as the two mandatory sizes.
      name: 'mobile-390',
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: 'desktop-1440',
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
});
