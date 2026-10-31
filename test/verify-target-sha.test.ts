import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The command that decides whether a commit may be deployed, driven end to end.
 *
 * `test/deploy-ref.test.ts` covers the rule as a pure function. This file covers
 * the wiring around it, because the wiring is where the trust boundary lives: the
 * command reads its facts from the GitHub API and nothing else, refuses an
 * untrusted dispatch ref before it does anything, and publishes one output that
 * the credential-holding job consumes.
 *
 * A local HTTP stand-in plays the API, so every branch below is reachable without
 * a token, a network, or a real repository.
 */

const run = promisify(execFile);

const SHA = 'b3da79653775a5a1741c652ce30402fdf2fda0d5';
const REPOSITORY = 'minhlongs/sadec-opc-webapp';
let server: Server | null = null;

interface Answer {
  status: number;
  body: unknown;
}

type Route = (path: string) => Answer;

async function start(route: Route): Promise<string> {
  server = createServer((request, response) => {
    const answer = route(request.url ?? '/');
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
  }
});

function gateRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 41202814493,
    head_sha: SHA,
    head_branch: 'main',
    path: '.github/workflows/verify.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

/** A repository where the commit is on main and the gate passed. */
function healthy(overrides: { compare?: string; runs?: unknown[] } = {}): Route {
  return (path) => {
    if (path === `/repos/${REPOSITORY}/commits/${SHA}`) {
      return { status: 200, body: { sha: SHA } };
    }
    if (path.startsWith(`/repos/${REPOSITORY}/compare/`)) {
      return { status: 200, body: { status: overrides.compare ?? 'ahead' } };
    }
    if (path.startsWith(`/repos/${REPOSITORY}/actions/workflows/verify.yml/runs`)) {
      return { status: 200, body: { workflow_runs: overrides.runs ?? [gateRun()] } };
    }
    return { status: 404, body: { message: 'not found' } };
  };
}

async function invoke(
  base: string,
  args: string[],
  environment: Record<string, string | undefined> = {},
) {
  return run('node', ['scripts/verify-target-sha.ts', ...args], {
    env: {
      ...process.env,
      SADEC_GITHUB_API_BASE: base,
      GH_TOKEN: 'stand-in-token',
      GITHUB_OUTPUT: '',
      ...environment,
    },
  });
}

describe('verify-target-sha', () => {
  it('accepts a commit on main with a successful gate run, and prints the evidence', async () => {
    const base = await start(healthy());
    const result = await invoke(base, ['--sha', SHA, '--repository', REPOSITORY]);
    expect(result.stdout).toContain('Gate:');
    expect(result.stdout).toContain('actions/runs/41202814493');
    expect(result.stdout).toContain('Compare:    main...');
  });

  it('publishes exactly one output line, which is what downstream jobs check out', async () => {
    const base = await start(healthy());
    const output = `${process.env.TMPDIR ?? '/tmp'}/sadec-verify-${process.pid}.txt`;
    await run('bash', ['-c', `: > ${output}`]);
    await invoke(base, ['--sha', SHA, '--repository', REPOSITORY, '--github-output', output]);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(output, 'utf8')).toBe(`sha=${SHA}\n`);
  });

  it('refuses a dispatch from another ref before it asks the API anything', async () => {
    let asked = 0;
    const base = await start((path) => {
      asked += 1;
      return healthy()(path);
    });
    await expect(
      invoke(base, ['--sha', SHA, '--repository', REPOSITORY, '--dispatch-ref', 'refs/heads/feat/x']),
    ).rejects.toMatchObject({ code: 1 });
    expect(asked).toBe(0);
  });

  it('refuses a branch name without touching the network', async () => {
    let asked = 0;
    const base = await start((path) => {
      asked += 1;
      return healthy()(path);
    });
    await expect(
      invoke(base, ['--sha', 'main', '--repository', REPOSITORY, '--dispatch-ref', 'refs/heads/main']),
    ).rejects.toMatchObject({ code: 2 });
    expect(asked).toBe(0);
  });

  it('refuses a commit that is not on main', async () => {
    const base = await start(healthy({ compare: 'diverged' }));
    const failure = await invoke(base, ['--sha', SHA, '--repository', REPOSITORY]).catch(
      (error: { stderr: string; code: number }) => error,
    );
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain('is not on main');
  });

  it('refuses when there is no successful gate run for that commit', async () => {
    const base = await start(
      healthy({ runs: [gateRun({ conclusion: 'failure' }), gateRun({ status: 'in_progress', conclusion: null })] }),
    );
    const failure = await invoke(base, ['--sha', SHA, '--repository', REPOSITORY]).catch(
      (error: { stderr: string; code: number }) => error,
    );
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain('no successful run');
  });

  it('refuses a green pull-request run, which tested a merge commit', async () => {
    const base = await start(healthy({ runs: [gateRun({ event: 'pull_request', head_branch: null })] }));
    await expect(invoke(base, ['--sha', SHA, '--repository', REPOSITORY])).rejects.toMatchObject({ code: 1 });
  });

  it('refuses a commit this repository does not have', async () => {
    const base = await start((path) =>
      path.startsWith(`/repos/${REPOSITORY}/commits/`)
        ? { status: 404, body: { message: 'Not Found' } }
        : healthy()(path),
    );
    await expect(invoke(base, ['--sha', SHA, '--repository', REPOSITORY])).rejects.toMatchObject({ code: 1 });
  });

  it('refuses when the runs API cannot be read, because an unconfirmed gate is not a pass', async () => {
    const base = await start((path) =>
      path.includes('/actions/workflows/')
        ? { status: 403, body: { message: 'Resource not accessible by integration' } }
        : healthy()(path),
    );
    const failure = await invoke(base, ['--sha', SHA, '--repository', REPOSITORY]).catch(
      (error: { stderr: string; code: number }) => error,
    );
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain('cannot be confirmed');
  });

  it('refuses when the compare API cannot be read', async () => {
    const base = await start((path) =>
      path.includes('/compare/') ? { status: 500, body: {} } : healthy()(path),
    );
    await expect(invoke(base, ['--sha', SHA, '--repository', REPOSITORY])).rejects.toMatchObject({ code: 1 });
  });

  it('refuses without a token rather than answering from nothing', async () => {
    await expect(
      invoke('http://127.0.0.1:1', ['--sha', SHA, '--repository', REPOSITORY], { GH_TOKEN: '' }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('requires a repository to be named', async () => {
    const base = await start(healthy());
    await expect(invoke(base, ['--sha', SHA, '--repository', 'not-a-repo'])).rejects.toMatchObject({
      code: 2,
    });
  });
});
