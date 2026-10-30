import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The browser harness, checked as configuration rather than by running it.
 *
 * `pnpm test:e2e` is only evidence if the servers and the database it drives are
 * the ones in the working tree. Three settings decide that, and each of them has
 * already been wrong once:
 *
 *   - `reuseExistingServer: true` let a stale, hand-started server be reused, so
 *     the suite reported green for code nobody had just edited;
 *   - parallel workers raced for the same seeded lots, so a spec could fail on
 *     another spec's booking (or pass because of one);
 *   - a retry would have turned either failure into a green run.
 *
 * These are assertions about `playwright.config.ts` and `scripts/e2e-prepare.ts`
 * because the failure they prevent is a *silent* one: the suite passes, and the
 * numbers mean something other than what they appear to mean.
 */

const ROOT = process.cwd();
const configText = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');
const prepareText = readFileSync(join(ROOT, 'scripts', 'e2e-prepare.ts'), 'utf8');

/** The file with its comments removed, for assertions about executed settings. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('the browser suite owns its database', () => {
  const executedConfig = withoutComments(configText);
  const executedPrepare = withoutComments(prepareText);

  it('points both servers and the reset at one directory of its own', () => {
    // One constant, used by both servers and by the reset script.
    expect(executedConfig).toMatch(/E2E_PERSIST_DIR\s*=\s*'\.wrangler\/e2e-state'/);
    expect(executedConfig.match(/SADEC_D1_PERSIST: E2E_PERSIST_DIR/g)?.length).toBe(2);
    expect(executedPrepare).toMatch(/E2E_PERSIST_DIR\s*=\s*'\.wrangler\/e2e-state'/);
  });

  it('never resets the developer’s own .wrangler/state', () => {
    // The failure this prevents: running the browser tests deletes a working
    // demo database somebody had been clicking through.
    const resetScope = executedPrepare.slice(
      executedPrepare.indexOf('function resetDemoDatabase'),
      executedPrepare.indexOf('function ensureDevVars'),
    );
    expect(resetScope).not.toContain("'.wrangler', 'state'");
    expect(resetScope).toContain('E2E_PERSIST_DIR');
    // The path components are joined from the suite's constant, not written as
    // a bare default.
    expect(executedPrepare).toContain("resolve(ROOT, E2E_PERSIST_DIR");
  });

  it('passes the suite directory to every migrate and seed command it runs', () => {
    expect(executedPrepare).toContain('SADEC_D1_PERSIST: E2E_PERSIST_DIR');
  });

  it('refuses a persist directory it would not be safe to delete', async () => {
    const { persistPathFromEnvironment } = await import('../scripts/require-environment.ts');
    expect(persistPathFromEnvironment({})).toBeNull();
    expect(persistPathFromEnvironment({ SADEC_D1_PERSIST: '  ' })).toBeNull();
    expect(persistPathFromEnvironment({ SADEC_D1_PERSIST: '.wrangler/e2e-state' })).toBe(
      '.wrangler/e2e-state',
    );
    for (const bad of ['/tmp/state', '../outside', '.wrangler/../../etc']) {
      expect(() => persistPathFromEnvironment({ SADEC_D1_PERSIST: bad }), bad).toThrow();
    }
  });
});

describe('the founder suite cannot be skipped out of an acceptance run', () => {
  const founderSpec = readFileSync(join(ROOT, 'e2e', 'founder-flow.spec.ts'), 'utf8');

  it('has no environment variable that skips it', () => {
    expect(founderSpec).not.toContain('SADEC_SKIP_FOUNDER_E2E');
    expect(founderSpec).not.toMatch(/test\.skip\(/);
  });

  it('fails, with the port named, when its server is missing or has the wrong identity', () => {
    expect(founderSpec).toContain('/api/session');
    expect(founderSpec).toContain("expect(session.role");
    expect(founderSpec).toMatch(/toBe\('founder_admin'\)/);
  });
});

describe('the browser suite is deterministic', () => {
  const executedConfig = withoutComments(configText);

  it('runs one worker and never retries', () => {
    expect(executedConfig).toMatch(/\bworkers:\s*1\b/);
    expect(executedConfig).toMatch(/\bretries:\s*0\b/);
    // A retry is how a lock error or a fixture collision becomes invisible.
    expect(executedConfig).not.toMatch(/\bretries:\s*[1-9]/);
  });

  it('never reuses a server somebody else started', () => {
    expect(executedConfig).not.toMatch(/reuseExistingServer:\s*true/);
    expect(executedConfig.match(/reuseExistingServer:\s*false/g)?.length).toBe(2);
  });

  it('starts both identities on their own fixed ports', () => {
    expect(executedConfig).toMatch(/port:\s*5173/);
    expect(executedConfig).toMatch(/port:\s*5174/);
    // The founder area needs the administrator identity, from its own file.
    expect(executedConfig).toContain("CLOUDFLARE_ENV: 'e2e-founder'");
    expect(executedConfig).toMatch(/--strictPort/);
  });

  it('checks the ports before it deletes the database', () => {
    const guard = prepareText.indexOf('assertSuitePortsFree');
    const reset = prepareText.indexOf('resetDemoDatabase()');
    expect(guard).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(-1);
    // The call site, not the definition: definition order in a file is not
    // execution order, so this compares the call inside `main`.
    const mainCall = prepareText.indexOf('await assertSuitePortsFree()');
    const mainReset = prepareText.indexOf('resetDemoDatabase();');
    expect(mainCall).toBeGreaterThan(-1);
    expect(mainReset).toBeGreaterThan(mainCall);
  });

  it('guards the same ports the config starts', () => {
    for (const port of ['5173', '5174']) {
      expect(configText).toContain(port);
      expect(prepareText).toContain(port);
    }
    // Cheap proof the two lists are the same list, not two drifting literals.
    expect(prepareText).toMatch(/SUITE_PORTS\s*=\s*\[5173,\s*5174\]/);
  });

  it('writes the founder identity from the template, never a secret', () => {
    const founderEnv = readFileSync(join(ROOT, 'scripts', 'e2e-founder-env.ts'), 'utf8');
    expect(founderEnv).toContain('DEV_IDENTITY_SUBJECT=demo-admin');
    expect(founderEnv).toContain("resolve(ROOT, '.env.example')");
    expect(founderEnv).not.toMatch(/ACCESS_AUD\s*=\s*[0-9a-f]{32,}/i);
  });
});
