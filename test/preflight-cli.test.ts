import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The preflight, run as the workflow runs it, against a stubbed Cloudflare API.
 *
 * These are not fixture tests of the decision: they execute
 * `scripts/cf-preflight.ts`, let it parse the JSON the API answers with, and read
 * the exit code. That is the boundary where the round-19 review's bug lived — the
 * decision received facts that had already lost the link between a rule's prefix
 * and its duration — so a test that only builds facts by hand would keep passing
 * while the CLI reported a 7-day prefix as 30-day protected.
 *
 * Nothing leaves the machine: the stub replaces `globalThis.fetch`.
 */

const STUB = new URL('../test/fixtures/cf-api-stub.mjs', import.meta.url).href;
const CLI = 'scripts/cf-preflight.ts';

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function preflight(scenario: string, envOverrides: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', STUB, CLI, '--purpose', 'backup'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STUB_SCENARIO: scenario,
          CLOUDFLARE_API_TOKEN: 'stub-token',
          CLOUDFLARE_ACCOUNT_ID: 'f691e83094f776311a1bfe3f8b126f1c',
          ACCESS_TEAM_DOMAIN: 'stub.cloudflareaccess.com',
          ACCESS_AUD: 'stub-audience',
          ...envOverrides,
        },
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        // `execFile` reports a non-zero exit as an error; the exit code is the
        // result these tests are about, so it is read rather than thrown.
        resolve({ code: error === null ? 0 : ((error.code as number | undefined) ?? 1), stdout, stderr });
      },
    );
  });
}

function line(run: Run, name: string): string {
  return run.stdout.split('\n').find((entry) => entry.includes(`${name}:`)) ?? '';
}

describe('the preflight CLI, on the data the API actually returns', () => {
  it('passes a bucket whose export prefix is retained and locked for 30 days', async () => {
    const run = await preflight('ok');
    expect(run.code).toBe(0);
    expect(line(run, 'bucket retention')).toContain('PASS');
    expect(line(run, 'bucket retention')).toContain('30-day expiry applies to pilot/');
    expect(line(run, 'bucket lock')).toContain('PASS');
    expect(run.stdout).toContain('RESOURCE PREFLIGHT PASSED');
  });

  it('fails when pilot/ is 7 days and other/ is 30, and never lends the 30', async () => {
    // The reported defect, end to end: exit 0 and two PASS lines before the fix.
    const run = await preflight('mixed');
    expect(run.code).toBe(1);
    expect(line(run, 'bucket retention')).toContain('FAIL');
    expect(line(run, 'bucket retention')).toContain('7-day expiry applies to pilot/');
    expect(line(run, 'bucket retention')).not.toContain('30-day expiry applies to pilot/');
    expect(line(run, 'bucket lock')).toContain('FAIL');
    expect(line(run, 'bucket lock')).toContain('7-day lock applies to pilot/');
    expect(line(run, 'bucket lock')).not.toContain('30-day lock applies to pilot/');
    expect(run.stdout).toContain('RESOURCE PREFLIGHT FAILED');
  });

  it('fails when only another prefix has a sufficient rule', async () => {
    const run = await preflight('other-only');
    expect(run.code).toBe(1);
    expect(line(run, 'bucket retention')).toContain('no enabled lifecycle rule applies to pilot/');
    expect(line(run, 'bucket lock')).toContain('no enabled lock rule applies to pilot/');
    expect(line(run, 'bucket lock')).toContain('other/');
  });

  it('fails when the rule on the right prefix is disabled', async () => {
    const run = await preflight('disabled');
    expect(run.code).toBe(1);
    expect(line(run, 'bucket retention')).toContain('disabled, so it enforces nothing');
    expect(line(run, 'bucket lock')).toContain('disabled, so it enforces nothing');
  });

  it('passes a bucket-wide rule, which really does cover the export prefix', async () => {
    const run = await preflight('wide');
    expect(run.code).toBe(0);
    expect(line(run, 'bucket retention')).toContain('30-day expiry applies to pilot/');
  });

  it('reads the nested API shape as the same rule', async () => {
    const run = await preflight('nested');
    expect(run.code).toBe(0);
    expect(line(run, 'bucket lock')).toContain('30-day lock applies to pilot/');
  });

  it('passes on the exact live Cloudflare REST API v4 D1 (uuid) and R2 lifecycle (maxAge) payload shapes', async () => {
    const run = await preflight('real-v4');
    expect(run.code).toBe(0);
    expect(line(run, 'database sadec-pilot')).toContain('PASS');
    expect(line(run, 'database sadec-pilot')).toContain('exists with the id the config binds');
    expect(line(run, 'bucket retention')).toContain('PASS');
    expect(line(run, 'bucket retention')).toContain('30-day expiry applies to pilot/');
    expect(line(run, 'bucket lock')).toContain('PASS');
    expect(line(run, 'bucket lock')).toContain('30-day lock applies to pilot/');
    expect(run.stdout).toContain('RESOURCE PREFLIGHT PASSED');
  });

  it('passes purpose=backup with INFO when ACCESS_TEAM_DOMAIN and ACCESS_AUD are empty', async () => {
    const run = await preflight('real-v4', { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' });
    expect(run.code).toBe(0);
    expect(line(run, 'Access configuration present')).toContain('INFO');
    expect(line(run, 'Access configuration present')).toContain('`deploy` and `bootstrap` still refuse');
    expect(run.stdout).toContain('RESOURCE PREFLIGHT PASSED for purpose "backup"');
  });

  it('does not accept a lookalike prefix', async () => {
    const run = await preflight('lookalike');
    expect(run.code).toBe(1);
    expect(line(run, 'bucket retention')).toContain('pilot-archive/');
  });

  it('refuses when the rule on the right prefix cannot be read', async () => {
    const run = await preflight('unreadable');
    expect(run.code).toBe(1);
    expect(line(run, 'bucket retention')).toContain('could not be read');
    expect(line(run, 'bucket lock')).toContain('could not be read');
  });

  it('fails when there are no rules at all', async () => {
    const run = await preflight('none');
    expect(run.code).toBe(1);
    expect(line(run, 'bucket retention')).toContain('FAIL');
    expect(line(run, 'bucket lock')).toContain('FAIL');
  });

  it('says the login was not verified even when the resources pass', async () => {
    const run = await preflight('ok');
    expect(run.stdout).toContain('ACCESS LOGIN NOT VERIFIED');
  });

  it('never prints the token it was given', async () => {
    for (const scenario of ['ok', 'mixed']) {
      const run = await preflight(scenario);
      expect(run.stdout).not.toContain('stub-token');
      expect(run.stderr).not.toContain('stub-token');
    }
  });
});
