import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapStatements,
  renderSqlScript,
  type FounderBootstrapInput,
} from '../src/ops/founder-bootstrap.ts';

/**
 * The provisioning command through its real transport, not through D1's API.
 *
 * `applyFounderBootstrap` is proved atomic in `test/founder-bootstrap.test.ts`
 * against a D1-shaped harness whose `batch` rolls back. That harness is this
 * repository's *model* of D1, and a model cannot prove what `wrangler d1 execute`
 * does with a file of statements. This file proves the transport itself:
 *
 *   - a file whose last statement fails leaves nothing behind, which is only true
 *     if the statements before it were in the same transaction;
 *   - two real CLI processes racing on one database produce one founder;
 *   - preview through the CLI writes nothing;
 *   - a second apply reports "already" and adds no audit row.
 *
 * It is deliberately slow (wrangler is spawned, once per statement group) and it
 * uses a private persistence directory under `.wrangler/`, so it cannot touch a
 * developer's database, the browser suite's database, or a remote one.
 */

const REPO = new URL('..', import.meta.url);

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function wrangler(args: string[], persist: string): RunResult {
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', ...args, '--local', '--persist-to', persist],
    { cwd: REPO, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function query(persist: string, sql: string): Record<string, unknown>[] {
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', 'sadec_test', '--local', '--persist-to', persist, '--json', '--command', sql],
    { cwd: REPO, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`query failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  }
  const stdout = result.stdout ?? '';
  const start = stdout.search(/^\[/m);
  const parsed = JSON.parse(stdout.slice(start)) as { results?: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

const counts = (persist: string): string =>
  JSON.stringify(
    query(
      persist,
      `SELECT (SELECT COUNT(*) FROM workspaces) AS workspaces,
              (SELECT COUNT(*) FROM identities) AS identities,
              (SELECT COUNT(*) FROM memberships) AS memberships,
              (SELECT COUNT(*) FROM audit_events) AS audit`,
    )[0],
  );

function freshDirectory(label: string): string {
  const path = join('.wrangler', `transport-${label}-${Date.now().toString(36)}`);
  const result = wrangler(['migrations', 'apply', 'sadec_test'], path);
  if (result.status !== 0) {
    throw new Error(`could not prepare ${path}: ${result.stdout}\n${result.stderr}`);
  }
  return path;
}

/** Runs the real command as a child process, with its own persistence directory. */
function runCli(args: string[], persist: string): Promise<RunResult & { code: number | null }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('node', ['scripts/bootstrap-founder.ts', ...args], {
      cwd: REPO,
      env: { ...process.env, SADEC_D1_PERSIST: persist },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, code, stdout, stderr }));
  });
}

const INPUT: FounderBootstrapInput = {
  environment: 'test',
  workspaceId: 'ws-transport',
  workspaceName: 'Vườn transport',
  accessSubject: 'sub-transport-alpha',
  email: 'alpha@transport.example.test',
  reason: 'Transport proof: one transaction through wrangler d1 execute',
  operator: 'ops:transport-test',
  ticket: 'CHG-TRANSPORT-1',
  timestamp: '2026-10-30T09:00:00.000Z',
  ids: { identity: 'id-transport', membership: 'mb-transport', audit: 'ae-transport' },
};

describe('the SQL file transport is one transaction', () => {
  let persist: string;
  const scriptPath = join(tmpdir(), `sadec-transport-${process.pid}.sql`);

  beforeAll(() => {
    persist = freshDirectory('rollback');
  });

  afterAll(() => {
    rmSync(persist, { recursive: true, force: true });
    rmSync(scriptPath, { force: true });
  });

  it('rolls back every earlier statement when the last one fails', () => {
    const statements = bootstrapStatements(INPUT, { createWorkspace: true, createIdentity: true });
    // A statement that cannot succeed: `roles` has a CHECK that admits exactly
    // three values. It runs *after* the workspace, identity and audit inserts, so
    // if the file were applied statement by statement without a transaction, all
    // three would survive.
    const failing = {
      sql: `INSERT INTO roles (role) VALUES ('deliberate-transport-failure')`,
      params: [],
    };
    writeFileSync(scriptPath, `${renderSqlScript([...statements, failing])}\n`);

    const result = wrangler(['execute', 'sadec_test', '--file', scriptPath], persist);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/CHECK constraint failed/i);

    // Nothing survived — including the rows whose own statements succeeded.
    expect(counts(persist)).toBe(
      JSON.stringify({ workspaces: 0, identities: 0, memberships: 0, audit: 0 }),
    );
  }, 60_000);

  it('writes all of it when the same file succeeds', () => {
    const statements = bootstrapStatements(INPUT, { createWorkspace: true, createIdentity: true });
    writeFileSync(scriptPath, `${renderSqlScript(statements)}\n`);

    const result = wrangler(['execute', 'sadec_test', '--file', scriptPath], persist);
    expect(`${result.stdout}${result.stderr}`).toMatch(/executed successfully/i);

    expect(counts(persist)).toBe(
      JSON.stringify({ workspaces: 1, identities: 1, memberships: 1, audit: 1 }),
    );
    const detail = JSON.parse(
      String(query(persist, 'SELECT detail FROM audit_events')[0]?.detail),
    ) as Record<string, unknown>;
    expect(detail.operator).toBe('ops:transport-test');
    expect(detail.operator_reference).toBe('declared');
  }, 60_000);
});

describe('two real CLI invocations on one private database', () => {
  let persist: string;

  beforeAll(() => {
    persist = freshDirectory('race');
  });

  afterAll(() => {
    rmSync(persist, { recursive: true, force: true });
  });

  const argsFor = (suffix: string): string[] => [
    '--env',
    'test',
    '--workspace-id',
    'ws-cli-race',
    '--workspace-name',
    'Vườn race',
    '--access-sub',
    `sub-cli-${suffix}`,
    '--email',
    `${suffix}@cli.example.test`,
    '--reason',
    'Concurrency proof through two real CLI processes',
    '--operator',
    'ops:race-test',
    '--apply',
    '--subject-verified',
  ];

  it('grants exactly one founder, and a re-run adds no audit row', async () => {
    // Preview first: it must not write.
    const preview = await runCli(
      [
        '--env',
        'test',
        '--workspace-id',
        'ws-cli-race',
        '--workspace-name',
        'Vườn race',
        '--access-sub',
        'sub-cli-preview',
        '--email',
        'preview@cli.example.test',
        '--reason',
        'Preview must not write anything at all',
        '--operator',
        'ops:race-test',
      ],
      persist,
    );
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain('Nothing was written');
    expect(counts(persist)).toBe(
      JSON.stringify({ workspaces: 0, identities: 0, memberships: 0, audit: 0 }),
    );

    // Two applies at once, different subjects: the second may lose either by
    // refusing a second founder or by finding the state changed under it.
    const [first, second] = await Promise.all([
      runCli(argsFor('alpha'), persist),
      runCli(argsFor('beta'), persist),
    ]);

    // Two processes on one SQLite file can also collide at the transport level —
    // one of them may fail to read while the other is writing, or lose the write
    // itself. That is a property of the local runtime, not of this command, so the
    // assertion is the invariant that must hold whatever the timing: never two
    // founders, and never a partial transaction.
    const succeeded = [first, second].filter((run) => run.code === 0);
    expect(succeeded.length).toBeLessThanOrEqual(1);
    for (const run of [first, second]) {
      // 0 = wrote, 3 = refused by policy, 4 = wrote nothing (state moved, or the
      // database could not be read), 1 = the write itself failed without saying
      // whether it landed. All four have been observed on this runtime, which is
      // why the exit code is not the thing being asserted here.
      expect([0, 1, 3, 4]).toContain(run.code);
      // Whatever else happens, a run that did not succeed never claims it wrote.
      if (run.code !== 0) expect(run.stdout).not.toMatch(/Created in one transaction/);
    }

    const state = query(
      persist,
      `SELECT (SELECT COUNT(*) FROM memberships WHERE role = 'founder_admin' AND revoked_at IS NULL) AS founders,
              (SELECT COUNT(*) FROM audit_events WHERE actor_source = 'provisioning') AS provisioning,
              (SELECT COUNT(*) FROM workspaces) AS workspaces,
              (SELECT COUNT(*) FROM memberships) AS memberships,
              (SELECT COUNT(*) FROM identities) AS identities`,
    )[0];

    // The safety property, stated so that every timing satisfies it: the rows a
    // bootstrap writes are a set of four, and they are all there or none are.
    // A run that lost the transport may have committed — exit 1 says exactly
    // that it cannot tell — so "one run failed" is not evidence of "nothing
    // landed". Two founders is the outcome that must never be reachable.
    expect(Number(state?.founders)).toBeLessThanOrEqual(1);
    const rowsWritten =
      Number(state?.workspaces) +
      Number(state?.identities) +
      Number(state?.memberships) +
      Number(state?.provisioning);
    expect([0, 4]).toContain(rowsWritten);
    if (rowsWritten === 4) {
      expect(Number(state?.founders)).toBe(1);
      expect(Number(state?.workspaces)).toBe(1);
      expect(Number(state?.identities)).toBe(1);
      expect(Number(state?.memberships)).toBe(1);
      expect(Number(state?.provisioning)).toBe(1);
    } else {
      expect(Number(state?.founders)).toBe(0);
    }
    if (succeeded.length === 1) {
      // A run that reported success must be the one whose rows are there.
      expect(rowsWritten).toBe(4);
    }

    // A sequential run afterwards is the honest next step an operator takes, and
    // it must land in a consistent state either way.
    const third = await runCli(argsFor('gamma'), persist);
    const settled = query(
      persist,
      `SELECT (SELECT COUNT(*) FROM memberships WHERE role = 'founder_admin' AND revoked_at IS NULL) AS founders,
              (SELECT COUNT(*) FROM audit_events WHERE actor_source = 'provisioning') AS provisioning,
              (SELECT COUNT(*) FROM memberships) AS memberships`,
    )[0];
    expect(Number(settled?.founders)).toBe(1);
    expect(Number(settled?.provisioning)).toBe(1);
    expect(Number(settled?.memberships)).toBe(1);
    expect([0, 3]).toContain(third.code);
    if (third.code === 3) expect(third.stderr).toMatch(/founder_exists/);

    // Whoever holds the grant can be re-run: "already", and no second audit row.
    const winner = query(
      persist,
      `SELECT i.access_sub AS subject
         FROM memberships m JOIN identities i ON i.id = m.identity_id
        WHERE m.role = 'founder_admin' AND m.revoked_at IS NULL`,
    )[0] as { subject: string };
    const again = await runCli(argsFor(winner.subject.replace('sub-cli-', '')), persist);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already holds a live founder_admin/i);

    const after = query(
      persist,
      `SELECT (SELECT COUNT(*) FROM memberships) AS memberships,
              (SELECT COUNT(*) FROM audit_events) AS audit`,
    )[0];
    expect(Number(after?.memberships)).toBe(1);
    expect(Number(after?.audit)).toBe(1);
  }, 180_000);
});

describe('the command reads nothing from files it was not given', () => {
  it('is a self-contained script: no secret file, no network, no token', () => {
    const source = readFileSync(new URL('../scripts/bootstrap-founder.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('.dev.vars');
    expect(source).not.toMatch(/process\.env\.(ACCESS_|CF_|CLOUDFLARE_)/);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});
