import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { setMembershipStore, setVerifier } from '../src/worker/index.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';

/**
 * Tenant boundary through the real fetch handler on real migrations.
 *
 * The request names a workspace; the membership table decides. These tests
 * pin the three places where a name used to be taken as evidence:
 *   - a founder write with `target_workspace_id`,
 *   - the founder OPC ledger read,
 *   - the `/api/session` switcher list.
 */

const ORIGIN = 'https://pilot.example.test';
const CTX: { access?: unknown } = {};

type Identity = 'demo-admin' | 'demo-owner' | 'demo-operator';

function post(path: string, workspaceId: string, body: unknown): Request {
  const url = new URL(path, ORIGIN);
  url.searchParams.set('workspace_id', workspaceId);
  return new Request(url, {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path: string, workspaceId: string, extra: Record<string, string> = {}): Request {
  const url = new URL(path, ORIGIN);
  url.searchParams.set('workspace_id', workspaceId);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return new Request(url);
}

describe('a founder acts only on workspaces they administer', () => {
  let harness: ReturnType<typeof createSqliteD1>;
  const env = (identity: Identity): Record<string, unknown> => ({
    APP_ENV: 'development',
    DEV_IDENTITY: identity,
    DB: harness.db,
  });

  beforeEach(() => {
    harness = createSqliteD1({ seedDemo: true });
    setMembershipStore(null);
    setVerifier(null);
    // The seeded founder administers every demo workspace; take ws-demo-b away
    // so there is a workspace that exists and is not theirs.
    harness.raw
      .prepare("UPDATE memberships SET revoked_at = '2026-10-29T00:00:00.000Z' WHERE id = 'mb-demo-admin-b'")
      .run();
  });

  afterEach(() => {
    setMembershipStore(null);
    setVerifier(null);
  });

  function agreementsIn(workspaceId: string): number {
    const row = harness.raw
      .prepare('SELECT COUNT(*) AS total FROM opc_agreements WHERE workspace_id = ?')
      .get(workspaceId) as { total: number };
    return Number(row.total);
  }

  it('refuses a target_workspace_id the founder does not administer and writes nothing', async () => {
    const before = agreementsIn('ws-demo-b');
    const res = await worker.fetch(
      post('/api/founder/opc/agreements/create', 'ws-demo-a', {
        target_workspace_id: 'ws-demo-b',
        monthly_fee_vnd: 3000000,
        setup_fee_vnd: 10000000,
        effective_date: '2026-11-01',
      }),
      env('demo-admin'),
      CTX,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; error: string };
    expect(body.code).toBe('forbidden');
    expect(body.error).not.toMatch(/SQL|constraint/i);
    expect(agreementsIn('ws-demo-b')).toBe(before);
  });

  it('accepts a target_workspace_id the founder does administer', async () => {
    const res = await worker.fetch(
      post('/api/founder/opc/agreements/create', 'ws-demo-a', {
        target_workspace_id: 'ws-demo-c',
        monthly_fee_vnd: 3000000,
        setup_fee_vnd: 10000000,
        effective_date: '2026-11-01',
      }),
      env('demo-admin'),
      CTX,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agreement: { workspace_id: string } };
    expect(body.agreement.workspace_id).toBe('ws-demo-c');
  });

  it('refuses the same write for a non-founder even in their own workspace', async () => {
    const res = await worker.fetch(
      post('/api/founder/opc/agreements/create', 'ws-demo-a', {
        monthly_fee_vnd: 3000000,
        setup_fee_vnd: 10000000,
        effective_date: '2026-11-01',
      }),
      env('demo-owner'),
      CTX,
    );
    expect(res.status).toBe(403);
  });

  it('scopes the OPC ledger to administered workspaces and refuses a foreign filter', async () => {
    // Give ws-demo-b a ledger row so there is something to leak.
    harness.raw
      .prepare(
        `INSERT INTO opc_agreements (id, workspace_id, status, monthly_fee_vnd, setup_fee_vnd, effective_date, termination_date, price_plane_snapshot_json, created_at, updated_at)
         VALUES ('ag-b', 'ws-demo-b', 'active', 5000000, 0, '2026-10-01', NULL, '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      )
      .run();

    const all = await worker.fetch(get('/api/founder/opc/ledger', 'ws-demo-a'), env('demo-admin'), CTX);
    expect(all.status).toBe(200);
    const ledger = (await all.json()) as {
      agreements: { workspace_id: string }[];
      metrics: { active_mrr_vnd: number };
    };
    expect(ledger.agreements.map((a) => a.workspace_id)).toContain('ws-demo-a');
    expect(ledger.agreements.map((a) => a.workspace_id)).not.toContain('ws-demo-b');
    // Metrics follow the same scope: ws-demo-b's 5,000,000 MRR is not counted.
    expect(ledger.metrics.active_mrr_vnd).toBe(3000000);

    const foreign = await worker.fetch(
      get('/api/founder/opc/ledger', 'ws-demo-a', { target_workspace_id: 'ws-demo-b' }),
      env('demo-admin'),
      CTX,
    );
    expect(foreign.status).toBe(403);

    const own = await worker.fetch(
      get('/api/founder/opc/ledger', 'ws-demo-a', { target_workspace_id: 'ws-demo-a' }),
      env('demo-admin'),
      CTX,
    );
    expect(own.status).toBe(200);
  });

  it('the session lists exactly the caller’s live memberships', async () => {
    const res = await worker.fetch(get('/api/session', 'ws-demo-a'), env('demo-admin'), CTX);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { workspaceId: string; workspaces?: { workspaceId: string; role: string; name: string }[] };
    };
    const ids = body.session.workspaces?.map((w) => w.workspaceId) ?? [];
    expect(ids).toContain('ws-demo-a');
    expect(ids).toContain('ws-demo-c');
    expect(ids).not.toContain('ws-demo-b'); // revoked above

    // Selecting the revoked workspace does not grant it: the session answers
    // with a workspace the caller actually holds, and the UI compares the
    // confirmed id against what it asked for before switching anything.
    const revoked = await worker.fetch(get('/api/session', 'ws-demo-b'), env('demo-admin'), CTX);
    expect(revoked.status).toBe(200);
    const fallback = (await revoked.json()) as { session: { workspaceId: string } };
    expect(fallback.session.workspaceId).not.toBe('ws-demo-b');
    expect(ids).toContain(fallback.session.workspaceId);
  });
});
