import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * The live smoke command, tested against a stand-in Worker.
 *
 * The script exists so a live check is a command with an exit code rather than a
 * page of `curl` output somebody reads by eye. That is only true if its *own*
 * judgement is exercised: a version that passed everything would be worse than
 * no script, because it would be quoted as evidence. Each test below changes one
 * answer and asserts the verdict, including the distinction the script now draws
 * between **readiness** (is it serving?) and **fail-closed** (is it refusing?).
 *
 * The stand-in is in this process, so the child is spawned asynchronously:
 * `spawnSync` would block the event loop that has to answer it and deadlock.
 */

const SCRIPT = resolve(import.meta.dirname, '..', 'scripts', 'smoke-live.ts');

interface Answer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

type Route = (
  url: string,
  method: string,
  headers: Record<string, string | string[] | undefined>,
) => Answer;

/** A healthy deployment-shaped answer set: serving, and refusing everything else. */
const healthy: Route = (url): Answer => {
  if (url === '/api/health') return { status: 200, body: JSON.stringify({ status: 'ok', env: 'pilot' }) };
  if (url === '/api/public/catalog') {
    return {
      status: 200,
      body: JSON.stringify({ origin: 'http://example.test', lots: [{ lot_code: 'LOT-1', name: 'Hoa hồng' }] }),
      headers: { 'cache-control': 'public, max-age=60' },
    };
  }
  if (url === '/api/schema') return { status: 200, body: JSON.stringify({ quote: { type: 'object' } }) };
  if (url === '/api/discover') {
    return {
      status: 200,
      body: '<html><body>discover</body></html>',
      headers: { 'content-type': 'text/html; charset=utf-8' },
    };
  }
  // No credential verifies anywhere, so the chokepoint answers 401 first.
  return { status: 401, body: JSON.stringify({ error: 'Bạn chưa đăng nhập.', code: 'unauthorized' }) };
};

let server: Server | null = null;

/**
 * The machine's own non-loopback IPv4 address.
 *
 * The script refuses `--expect-env pilot` against a loopback host, on purpose, so
 * the deployment-shaped tests have to reach the stand-in the way a deployment is
 * reached: by an address that is not `localhost`. Binding 0.0.0.0 and connecting
 * over the interface address gives that without a DNS entry or a hosts file.
 */
function nonLoopbackAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

async function start(routes: Route, host = '127.0.0.1'): Promise<string> {
  server = createServer((req, res) => {
    const answer = routes(req.url ?? '/', req.method ?? 'GET', req.headers);
    res.writeHead(answer.status, {
      'content-type': 'application/json; charset=utf-8',
      ...(answer.headers ?? {}),
    });
    res.end(answer.body);
  });
  await new Promise<void>((done) => server!.listen(0, host, done));
  const { port } = server!.address() as AddressInfo;
  const reachable = host === '0.0.0.0' ? (nonLoopbackAddress() ?? '127.0.0.1') : host;
  return `http://${reachable}:${port}`;
}

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
  }
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runSmoke(args: readonly string[]): Promise<Run> {
  return new Promise((done) => {
    execFile('node', [SCRIPT, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      done({ code, stdout, stderr });
    });
  });
}

/**
 * The remote shape: a `--local` host is refused for a pilot expectation, so a
 * deployment-shaped run is driven with `--expect-env local` against a stand-in
 * that reports `local`, and the deployment-only assertions live in their own
 * tests below where the target is remote-shaped.
 */
describe('smoke:live', () => {
  it('passes a serving, fail-closed application', async () => {
    const url = await start((u, m, h) =>
      u === '/api/health' ? { status: 200, body: JSON.stringify({ status: 'ok', env: 'local' }) } : healthy(u, m, h),
    );
    const run = await runSmoke(['--base-url', url, '--local', '--expect-env', 'local']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('PASS  health');
    // The local adapter is on, so the identity checks are skipped with a reason
    // rather than reported as passes they did not earn.
    expect(run.stdout).toContain('INFO  identity checks');
  });

  it('runs every refusal, and passes, on a serving deployment-shaped target', async () => {
    const url = await start(healthy, '0.0.0.0');
    const run = await runSmoke(['--base-url', url, '--expect-env', 'pilot']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('PASS  health');
    expect(run.stdout).toContain('PASS  session/forged-access-jwt');
    expect(run.stdout).toContain('PASS  session/dev-identity');
    expect(run.stdout).toContain('PASS  guarded write');
    expect(run.stdout).toContain('PASS  public PII');
    expect(run.stdout).toContain('REMOTE');
  });

  it('refuses a localhost target without --local, so a local run cannot be filed as live evidence', async () => {
    const url = await start(healthy);
    const run = await runSmoke(['--base-url', url, '--expect-env', 'local']);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('without --local');
    expect(run.stdout).toBe('');
  });

  it('fails readiness on a 503 catalogue, while recording that the handling was correct', async () => {
    const url = await start((u, m, h) =>
      u === '/api/public/catalog'
        ? {
            status: 503,
            body: JSON.stringify({ error: 'Chưa đọc được danh mục.', code: 'catalog_unavailable' }),
            headers: { 'cache-control': 'no-store' },
          }
        : u === '/api/health'
          ? { status: 200, body: JSON.stringify({ status: 'ok', env: 'local' }) }
          : healthy(u, m, h),
    );
    const run = await runSmoke(['--base-url', url, '--local', '--expect-env', 'local']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  catalog');
    expect(run.stdout).toContain('not ready');
    // The point of the split: degraded handling is recorded as a note, never as a pass.
    expect(run.stdout).toContain('INFO  degraded handling');
    expect(run.stdout).toContain('NOT READY');
  });

  it('fails readiness on a 503 discovery page', async () => {
    const url = await start((u, m, h) =>
      u === '/api/discover'
        ? { status: 503, body: '<html>unavailable</html>', headers: { 'content-type': 'text/html; charset=utf-8' } }
        : u === '/api/health'
          ? { status: 200, body: JSON.stringify({ status: 'ok', env: 'local' }) }
          : healthy(u, m, h),
    );
    const run = await runSmoke(['--base-url', url, '--local', '--expect-env', 'local']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  discover');
  });

  it('fails readiness with a 200 that carries an error instead of a catalogue', async () => {
    const url = await start((u, m, h) =>
      u === '/api/public/catalog'
        ? { status: 200, body: JSON.stringify({ error: 'Hệ thống chưa sẵn sàng', lots: [] }) }
        : u === '/api/health'
          ? { status: 200, body: JSON.stringify({ status: 'ok', env: 'local' }) }
          : healthy(u, m, h),
    );
    const run = await runSmoke(['--base-url', url, '--local', '--expect-env', 'local']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  catalog');
    expect(run.stdout).toContain('200 carrying an error');
  });

  it('fails readiness when the Worker reports a different environment than the one expected', async () => {
    const url = await start((u, m, h) =>
      u === '/api/health' ? { status: 200, body: JSON.stringify({ status: 'ok', env: 'demo' }) } : healthy(u, m, h),
    );
    const run = await runSmoke(['--base-url', url, '--local', '--expect-env', 'local']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  environment');
    expect(run.stdout).toContain('reports APP_ENV="demo"');
  });

  it('fails when a forged Cf-Access-Jwt-Assertion is honoured', async () => {
    const url = await start(
      (u, m, h) =>
        u === '/api/session' && String(h['cf-access-jwt-assertion'] ?? '') !== ''
          ? { status: 200, body: JSON.stringify({ identity: { role: 'founder_admin' } }) }
          : healthy(u, m, h),
      '0.0.0.0',
    );
    const run = await runSmoke(['--base-url', url, '--expect-env', 'pilot']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  session/forged-access-jwt');
  });

  it('fails when the public catalogue exposes a private field', async () => {
    const url = await start(
      (u, m, h) =>
        u === '/api/public/catalog'
          ? { status: 200, body: JSON.stringify({ lots: [{ lot_code: 'LOT-1', buyer_contact_phone: '0900000000' }] }) }
          : healthy(u, m, h),
      '0.0.0.0',
    );
    const run = await runSmoke(['--base-url', url, '--expect-env', 'pilot']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  public PII');
  });

  it('reports an unreachable host as a failure rather than as a pass', async () => {
    const run = await runSmoke(['--base-url', 'http://127.0.0.1:1', '--local', '--expect-env', 'local']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  health');
    expect(run.stdout).toContain('could not connect');
  });

  it('requires a target and an expected environment', async () => {
    const missingTarget = await runSmoke([]);
    expect(missingTarget.code).toBe(2);
    expect(missingTarget.stderr).toContain('Usage: pnpm smoke:live');

    const missingEnv = await runSmoke(['--base-url', 'http://127.0.0.1:1', '--local']);
    expect(missingEnv.code).toBe(2);
    expect(missingEnv.stderr).toContain('--expect-env is required');
  });

  it('refuses to expect a deployment environment from a local host', async () => {
    const run = await runSmoke(['--base-url', 'http://127.0.0.1:1', '--local', '--expect-env', 'pilot']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('cannot be right');
  });
});
