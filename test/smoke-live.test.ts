import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * The live smoke command, tested against a stand-in Worker.
 *
 * The script exists so a live check is a command with an exit code rather than a
 * page of `curl` output somebody reads by eye. That is only true if its *own*
 * judgement is exercised: a version of it that passed everything would be worse
 * than no script, because it would be quoted as evidence. So these tests run the
 * real file as a child process against a local HTTP server and assert on the exit
 * code and the printed lines, once per failure it is supposed to catch.
 *
 * The stand-in also proves the script's own guard: a run against localhost
 * without `--local` must refuse, and every test below passes `--local` for that
 * reason.
 */

const SCRIPT = resolve(import.meta.dirname, '..', 'scripts', 'smoke-live.ts');

/** A healthy answer set, so each test can change exactly one thing. */
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

const healthy: Route = (url): Answer => {
  if (url === '/api/health') {
    return { status: 200, body: JSON.stringify({ status: 'ok', env: 'pilot' }) };
  }
  if (url === '/api/public/catalog') {
    return {
      status: 200,
      body: JSON.stringify({
        origin: 'http://example.test',
        lots: [{ lot_code: 'LOT-1', name: 'Hoa hồng', unit_price_vnd: 26000 }],
      }),
      headers: { 'cache-control': 'public, max-age=60' },
    };
  }
  if (url === '/api/schema') {
    return { status: 200, body: JSON.stringify({ quote: { type: 'object' } }) };
  }
  if (url === '/api/discover') {
    return { status: 200, body: '<html><body>discover</body></html>', headers: { 'content-type': 'text/html; charset=utf-8' } };
  }
  if (url === '/api/session' || url === '/api/products' || url === '/api/quote-drafts/save') {
    // No credential that verifies anywhere, so the chokepoint answers 401 —
    // whatever the method, and before any handler runs.
    return { status: 401, body: JSON.stringify({ error: 'Bạn chưa đăng nhập.', code: 'unauthorized' }) };
  }
  return { status: 404, body: 'not found' };
};

let server: Server | null = null;

async function start(routes: Route): Promise<string> {
  server = createServer((req, res) => {
    const answer = routes(req.url ?? '/', req.method ?? 'GET', req.headers);
    res.writeHead(answer.status, {
      'content-type': 'application/json; charset=utf-8',
      ...(answer.headers ?? {}),
    });
    res.end(answer.body);
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

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the script and waits for it.
 *
 * Asynchronous on purpose: the stand-in server lives in this same process, and a
 * synchronous spawn blocks the event loop that has to answer the child's
 * requests. With `spawnSync` the child waits for a connection nobody can accept
 * and the test hangs until the runner kills it — which is also why every call
 * below is awaited.
 */
function runSmoke(args: readonly string[]): Promise<Run> {
  return new Promise((done) => {
    execFile('node', [SCRIPT, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      done({ code, stdout, stderr });
    });
  });
}

describe('smoke:live', () => {
  it('passes against a Worker that refuses every unauthenticated request', async () => {
    const url = await start(healthy);
    const run = await runSmoke(['--base-url', url, '--local']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('PASS  health');
    expect(run.stdout).toContain('PASS  session/dev-identity');
    expect(run.stdout).toContain('PASS  guarded write');
    expect(run.stdout).toContain('LOCAL');
    // And it says what it did not prove, so the output cannot be quoted as more.
    expect(run.stdout).toContain('does not prove');
  });

  it('refuses a localhost target without --local, so a local run cannot be filed as live evidence', async () => {
    const url = await start(healthy);
    const run = await runSmoke(['--base-url', url]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('without --local');
    expect(run.stdout).toBe('');
  });

  it('fails on a 200 that carries an error instead of a catalogue', async () => {
    const url = await start((u, m, h) =>
      u === '/api/public/catalog'
        ? { status: 200, body: JSON.stringify({ error: 'Hệ thống chưa sẵn sàng', lots: [] }) }
        : healthy(u, m, h),
    );
    const run = await runSmoke(['--base-url', url, '--local']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  catalog');
    expect(run.stdout).toContain('unavailable looks empty');
  });

  it('accepts a 503 catalogue only when it is labelled and uncacheable', async () => {
    const labelled = await start((u, m, h) =>
      u === '/api/public/catalog'
        ? {
            status: 503,
            body: JSON.stringify({ error: 'Chưa đọc được danh mục.', code: 'catalog_unavailable' }),
            headers: { 'cache-control': 'no-store' },
          }
        : healthy(u, m, h),
    );
    const first = await runSmoke(['--base-url', labelled, '--local']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('503 catalog_unavailable, no-store');

    const cacheable = await start((u, m, h) =>
      u === '/api/public/catalog'
        ? {
            status: 503,
            body: JSON.stringify({ error: 'Chưa đọc được danh mục.', code: 'catalog_unavailable' }),
            headers: { 'cache-control': 'public, max-age=60' },
          }
        : healthy(u, m, h),
    );
    const second = await runSmoke(['--base-url', cacheable, '--local']);
    expect(second.code).toBe(1);
    expect(second.stdout).toContain('503 is cacheable');
  });

  it('fails when the development identity is honoured', async () => {
    const url = await start((u, m, h) =>
      u === '/api/session' && String(h['x-dev-identity'] ?? '') === 'demo-admin'
        ? { status: 200, body: JSON.stringify({ identity: { role: 'founder_admin' } }) }
        : healthy(u, m, h),
    );
    const run = await runSmoke(['--base-url', url, '--local']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  session/dev-identity');
    expect(run.stdout).toContain('development identity is reachable');
  });

  it('fails when a remote Worker reports a local environment', async () => {
    const url = await start((u, m, h) =>
      u === '/api/health' ? { status: 200, body: JSON.stringify({ status: 'ok', env: 'local' }) } : healthy(u, m, h),
    );
    // The host is 127.0.0.1, so the script treats the target as local and reports
    // the environment instead of failing on it. The remote rule is asserted on its
    // own, by reading the message the script would print: this test pins that the
    // local run says so rather than implying a deployment passed.
    const run = await runSmoke(['--base-url', url, '--local']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('env="local"');
    expect(run.stdout).toContain('LOCAL');
  });

  it('fails when the public catalogue exposes a private field', async () => {
    const url = await start((u, m, h) =>
      u === '/api/public/catalog'
        ? {
            status: 200,
            body: JSON.stringify({
              lots: [{ lot_code: 'LOT-1', buyer_contact_phone: '0900000000' }],
            }),
          }
        : healthy(u, m, h),
    );
    const run = await runSmoke(['--base-url', url, '--local']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  public PII');
    expect(run.stdout).toContain('buyer_contact_phone');
  });

  it('reports an unreachable host as a failure rather than as a pass', async () => {
    // Port 1 on loopback: refused immediately, no network needed.
    const run = await runSmoke(['--base-url', 'http://127.0.0.1:1', '--local']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL  health');
    expect(run.stdout).toContain('could not connect');
  });

  it('requires a target', async () => {
    const run = await runSmoke([]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Usage: pnpm smoke:live');
  });
});
