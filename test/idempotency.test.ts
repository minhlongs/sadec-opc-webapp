import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { setMembershipStore, setVerifier } from '../src/worker/index.ts';
import { withIdempotency } from '../src/ops/idempotency.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';

/**
 * A money-moving POST sent twice with the same `Idempotency-Key` is one
 * record and the same answer. Through the real fetch handler on the real
 * migrations, so the reservation row, the body hash and the replay are the
 * production ones.
 */

const ORIGIN = 'https://pilot.example.test';
const CTX: { access?: unknown } = {};

const BOOKING = {
  lot_id: 'lot-w-02',
  quantity: 20,
  buyer_shop_name: 'Tiệm Hoa Sài Gòn Phố',
  buyer_contact_phone: '0903123456',
  destination_market: 'Chợ hoa Hồ Thị Kỷ, Quận 10',
};

function post(path: string, workspaceId: string, body: unknown, key?: string): Request {
  const url = new URL(path, ORIGIN);
  url.searchParams.set('workspace_id', workspaceId);
  const headers: Record<string, string> = {
    'Sec-Fetch-Site': 'same-origin',
    'content-type': 'application/json',
  };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('Idempotency-Key on a money-moving POST', () => {
  let harness: ReturnType<typeof createSqliteD1>;
  let env: Record<string, unknown>;

  beforeEach(() => {
    harness = createSqliteD1({ seedDemo: true });
    env = { APP_ENV: 'development', DEV_IDENTITY: 'demo-operator', DB: harness.db };
    setMembershipStore(null);
    setVerifier(null);
  });

  afterEach(() => {
    setMembershipStore(null);
    setVerifier(null);
  });

  function bookings(): number {
    const row = harness.raw
      .prepare("SELECT COUNT(*) AS total FROM b2b_bookings WHERE lot_id = 'lot-w-02'")
      .get() as { total: number };
    return Number(row.total);
  }

  function availableUnits(): number {
    const row = harness.raw
      .prepare("SELECT available_units FROM supply_lots WHERE id = 'lot-w-02'")
      .get() as { available_units: number };
    return Number(row.available_units);
  }

  it('a retry with the same key and body replays the first answer and writes nothing more', async () => {
    const key = 'intent-booking-0001';
    const first = await worker.fetch(post('/api/b2b/bookings/create', 'ws-shop-q1', BOOKING, key), env, CTX);
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotency-replayed')).toBe('false');
    const firstBody = await first.text();

    const retry = await worker.fetch(post('/api/b2b/bookings/create', 'ws-shop-q1', BOOKING, key), env, CTX);
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotency-replayed')).toBe('true');
    expect(await retry.text()).toBe(firstBody);

    expect(bookings()).toBe(1);
    expect(availableUnits()).toBe(130);
  });

  it('the same key with a different body is refused, not replayed and not executed', async () => {
    const key = 'intent-booking-0002';
    const first = await worker.fetch(post('/api/b2b/bookings/create', 'ws-shop-q1', BOOKING, key), env, CTX);
    expect(first.status).toBe(201);

    const other = await worker.fetch(
      post('/api/b2b/bookings/create', 'ws-shop-q1', { ...BOOKING, quantity: 30 }, key),
      env,
      CTX,
    );
    expect(other.status).toBe(409);
    const body = (await other.json()) as { code?: string };
    expect(body.code).toBe('idempotency_conflict');
    expect(bookings()).toBe(1);
    expect(availableUnits()).toBe(130);
  });

  it('a key is scoped to the workspace: another workspace with the same key is a fresh request', async () => {
    const key = 'intent-shared-string-01';
    const q1 = await worker.fetch(post('/api/b2b/bookings/create', 'ws-shop-q1', BOOKING, key), env, CTX);
    expect(q1.status).toBe(201);
    const damsen = await worker.fetch(
      post('/api/b2b/bookings/create', 'ws-shop-damsen', BOOKING, key),
      env,
      CTX,
    );
    expect(damsen.status).toBe(201);
    expect(damsen.headers.get('idempotency-replayed')).toBe('false');
    expect(bookings()).toBe(2);
  });

  it('two concurrent sends with one key produce one booking; the loser is told to wait or gets the replay', async () => {
    const key = 'intent-booking-concurrent';
    const [a, b] = await Promise.all([
      worker.fetch(post('/api/b2b/bookings/create', 'ws-shop-q1', BOOKING, key), env, CTX),
      worker.fetch(post('/api/b2b/bookings/create', 'ws-shop-q1', BOOKING, key), env, CTX),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    if (statuses[1] === 409) {
      const loser = a.status === 409 ? a : b;
      const body = (await loser.json()) as { code?: string };
      expect(body.code).toBe('idempotency_in_progress');
    }
    expect(bookings()).toBe(1);
    expect(availableUnits()).toBe(130);
  });

  it('a refused request is stored too, so a retry does not get a second chance at a different outcome', async () => {
    const key = 'intent-booking-too-many';
    const first = await worker.fetch(
      post('/api/b2b/bookings/create', 'ws-shop-q1', { ...BOOKING, quantity: 151 }, key),
      env,
      CTX,
    );
    expect(first.status).toBe(409);
    const retry = await worker.fetch(
      post('/api/b2b/bookings/create', 'ws-shop-q1', { ...BOOKING, quantity: 151 }, key),
      env,
      CTX,
    );
    expect(retry.status).toBe(409);
    expect(retry.headers.get('idempotency-replayed')).toBe('true');
    expect(bookings()).toBe(0);
  });

  it('rejects a malformed key before doing any work', async () => {
    const res = await worker.fetch(post('/api/b2b/bookings/create', 'ws-shop-q1', BOOKING, 'short'), env, CTX);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('validation');
    expect(bookings()).toBe(0);
  });

  it('a 5xx answer is not stored: the retry runs the handler again', async () => {
    let attempts = 0;
    const call = () =>
      withIdempotency({
        db: harness.db,
        workspaceId: 'ws-shop-q1',
        actionPath: '/api/test/flaky',
        key: 'intent-flaky-0001',
        rawBody: '{}',
        run: async () => {
          attempts += 1;
          return attempts === 1
            ? new Response(JSON.stringify({ error: 'tạm thời' }), { status: 503 })
            : new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
    expect((await call()).status).toBe(503);
    const second = await call();
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotency-replayed')).toBe('false');
    const third = await call();
    expect(third.status).toBe(200);
    expect(third.headers.get('idempotency-replayed')).toBe('true');
    expect(attempts).toBe(2);
  });

  it('a reservation abandoned by a dead worker is taken over after the timeout', async () => {
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    harness.raw
      .prepare(
        `INSERT INTO idempotency_keys (workspace_id, action_path, idempotency_key, request_hash, status, created_at)
         VALUES ('ws-shop-q1', '/api/test/stale', 'intent-stale-0001', ?, 'in_progress', ?)`,
      )
      .run(
        // sha256('/api/test/stale\n{}')
        await (async () => {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('/api/test/stale\n{}'));
          return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
        })(),
        stale,
      );
    let ran = 0;
    const res = await withIdempotency({
      db: harness.db,
      workspaceId: 'ws-shop-q1',
      actionPath: '/api/test/stale',
      key: 'intent-stale-0001',
      rawBody: '{}',
      run: async () => {
        ran += 1;
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    expect(res.status).toBe(200);
    expect(ran).toBe(1);
  });
});
