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
/**
 * An escape hatch for machines that cannot reach Playwright's browser CDN.
 *
 * When `SADEC_E2E_CHROMIUM_PATH` names a Chromium binary, the suite launches
 * that binary instead of the bundled one. It is read only from the environment,
 * never defaulted: an unset value keeps the bundled browser, so CI and a normal
 * workstation behave exactly as before. The extra flags are the ones a
 * container without a user namespace needs; they do nothing for the bundled
 * browser because they are only passed alongside an explicit path.
 */
const customChromium = process.env.SADEC_E2E_CHROMIUM_PATH?.trim();
const launchOptions =
  customChromium !== undefined && customChromium !== ''
    ? {
        executablePath: customChromium,
        args: [
          '--no-sandbox',
          '--no-zygote',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--use-gl=angle',
          '--use-angle=swiftshader',
        ],
      }
    : {};

/**
 * The local D1 directory the suite owns.
 *
 * Both suite servers and the prepare script point at this one directory, so the
 * suite reads and writes exactly one database — and it is not the one
 * `pnpm dev` uses (`.wrangler/state`). That matters because the suite resets its
 * database on every run: resetting the developer's database would delete
 * whatever they had been clicking through, which is not the suite's business.
 *
 * `.wrangler/` is gitignored, so this directory never reaches a commit.
 */
const E2E_PERSIST_DIR = '.wrangler/e2e-state';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/e2e',
  /**
   * One worker, and no retries.
   *
   * Both servers share one local D1 file (`wrangler.jsonc` declares the `local`
   * and `e2e-founder` runs against the same bindings), and the specs book real
   * units from the same seeded lots: `nursery-flow` accepts a quote, `b2b-flow`
   * reserves stock, `founder-flow` applies a config version. Run files in
   * parallel and two of them race for the same fixture, so a spec fails on
   * another spec's write rather than on the code. That is the kind of failure a
   * retry hides, which is why there is no retry: a lock error or a fixture
   * collision must be seen, not re-rolled. Deliberate concurrency lives in unit
   * tests (`test/nursery-transactions.test.ts`, `test/idempotency.test.ts`)
   * where two transactions are interleaved on purpose.
   */
  workers: 1,
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    // Vietnamese first, and the desktop width from §5.
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    baseURL: 'http://localhost:5173',
    launchOptions,
    // A failed browser test keeps its evidence. Traces and screenshots are only
    // written on failure, so a green run leaves nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    // One deterministic port for this project.
    //
    // `reuseExistingServer` is false on purpose. Reusing whatever already
    // listens on 5173 means the suite can drive a server started from an older
    // revision — or from another branch — and report green for code that is not
    // in the working tree. That is not hypothetical: a session that left two
    // hand-started servers behind found them reused, and the suite then tested
    // code nobody had just edited while it reset the database underneath them.
    // A stale server on these ports is now a startup error with the port named,
    // which is the honest outcome. `scripts/e2e-prepare.ts` checks the ports
    // before it deletes anything, so a developer learns it before the reset.
    {
      command: 'pnpm exec vite --port 5173 --strictPort',
      port: 5173,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { SADEC_D1_PERSIST: E2E_PERSIST_DIR },
    },
    // The founder area is founder-only, and the local dev identity is the
    // operator by default. A second server on its own port runs the same Worker
    // and the same local D1 with `DEV_IDENTITY_SUBJECT=demo-admin`, so the
    // founder suite can exercise that area through the browser without making
    // the operator an administrator on the main port. The identity comes from
    // `.dev.vars.e2e-founder`, which holds no secret — see
    // `scripts/e2e-founder-env.ts`, which writes it from `.env.example`.
    {
      command: 'pnpm exec vite --port 5174 --strictPort',
      port: 5174,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { CLOUDFLARE_ENV: 'e2e-founder', SADEC_D1_PERSIST: E2E_PERSIST_DIR },
    },
  ],
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
