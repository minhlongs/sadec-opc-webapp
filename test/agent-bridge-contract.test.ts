/**
 * The agent bridge's read contract, against a scripted server.
 *
 * The rule the bridge must not break: it reports what the server said, and says
 * which of three things happened when it could not.
 *
 *   - `OK`          — the server answered. `lots` may be empty; that is a fact.
 *   - `STALE`       — the refresh failed and a cached list is being shown. It is
 *                     marked, never passed off as current.
 *   - `UNAVAILABLE` — nobody could look. Distinct from empty, because an agent
 *                     that renders this as "no lots" tells a buyer the nursery is
 *                     out of stock when the truth is that nobody checked.
 *
 * `nursery_workspace_id` is absent from the view entirely. It used to be filled
 * with `'ws-public-catalog'`, a placeholder that looked like a tenant id; a
 * booking takes its workspace from the authenticated session on the server, so
 * nothing needs the field.
 *
 * The fetch stub is installed per test and restored afterwards, so no test here
 * depends on network access or on another test's cache.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAgentBridge } from '../src/ui/agent-bridge.ts';

/**
 * A bridge with empty module state.
 *
 * The cache, the staged proposal and the stale mark are module-level, which is
 * correct for a page — one bridge per tab — and wrong for tests in one file. A
 * fresh module instance per test means each test starts with nothing cached,
 * rather than inheriting the previous test's lots and reading `STALE`.
 */
async function freshBridge(workspaceId: string) {
  vi.resetModules();
  const mod = await import('../src/ui/agent-bridge.ts');
  return mod.initAgentBridge(workspaceId);
}

type Stub = { status: number; body: string };

const originalFetch = globalThis.fetch;

/** Serves the given responses in order, repeating the last one. */
function stubFetch(responses: readonly Stub[]): { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const handedCalls = calls as string[] & { paths: string[] };
  handedCalls.paths = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const stub = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (stub === undefined) throw new Error('no stub');
    return new Response(stub.body, {
      status: stub.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }) as typeof fetch;
  return { calls };
}

const SESSION_OK: Stub = {
  status: 200,
  body: JSON.stringify({ session: { workspaceId: 'ws-demo-a', role: 'workspace_operator' } }),
};

const LOT = {
  id: 'lot-w-01',
  lot_code: 'SDEC-LOT-W01',
  nursery_workspace_id: 'ws-demo-c',
  nursery_name: 'Vườn Hoa Tư Kiểng',
  name: 'Monstera Thai',
  mode: 'WEEKLY_CATALOG',
  species: 'Monstera deliciosa',
  grade: 'A',
  pot_diameter_cm: 25,
  height_cm: 55,
  canopy_cm: 45,
  bud_specification: '4-5 lá',
  media_proof_url: '',
  unit: 'chậu',
  unit_price_vnd: 220000,
  deposit_rate_bps: 3000,
  moq_units: 10,
  total_units: 100,
  available_units: 90,
  cut_or_ship_date: '2026-11-02',
  qr_lot_token: '',
  status: 'PUBLISHED',
  revision: 'lot-w-01:u90:PUBLISHED:2026-10-23T02:00:00.000Z',
  updated_at: '2026-10-23T02:00:00.000Z',
} as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('three outcomes, and only one of them is an empty catalogue', () => {
  it('a server that answers with lots is OK, and the view carries no workspace id', async () => {
    stubFetch([SESSION_OK, { status: 200, body: JSON.stringify({ lots: [LOT] }) }]);
    const bridge = await freshBridge('ws-demo-a');
    const result = await bridge.listSupplyLots();

    expect(result.status).toBe('OK');
    expect(result.stale).toBe(false);
    expect(result.message).toBeNull();
    expect(result.lots).toHaveLength(1);
    // The field is gone from the view, not blanked to a placeholder.
    expect(Object.keys(result.lots[0] ?? {})).not.toContain('nursery_workspace_id');
    expect(JSON.stringify(result)).not.toContain('ws-public-catalog');
    expect(JSON.stringify(result)).not.toContain('"nursery_workspace_id"');
  });

  it('a server that answers with nothing published is OK and empty', async () => {
    stubFetch([SESSION_OK, { status: 200, body: JSON.stringify({ lots: [] }) }]);
    const bridge = await freshBridge('ws-demo-a');
    const result = await bridge.listSupplyLots();

    expect(result.status).toBe('OK');
    expect(result.lots).toEqual([]);
    expect(result.stale).toBe(false);
  });

  it('a 503 catalog_unavailable is UNAVAILABLE, never an empty list', async () => {
    stubFetch([
      { status: 403, body: JSON.stringify({ error: 'forbidden', code: 'forbidden' }) },
      { status: 503, body: JSON.stringify({ error: 'Tạm thời…', code: 'catalog_unavailable' }) },
    ]);
    const bridge = await freshBridge('ws-demo-a');
    const result = await bridge.listSupplyLots();

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.lots).toEqual([]);
    expect(result.stale).toBe(false);
    expect(result.message).toMatch(/không truy cập được/i);
    // The distinction the whole change exists for.
    expect(result.status).not.toBe('OK');
  });

  it('a network failure with nothing cached is UNAVAILABLE too', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const bridge = await freshBridge('ws-demo-a');
    const result = await bridge.listSupplyLots();
    expect(result.status).toBe('UNAVAILABLE');
  });
});

describe('a failed refresh shows the cache only when it says so', () => {
  it('marks a cached list STALE, and refuses to build a proposal from it', async () => {
    // 1. A good read fills the cache.
    stubFetch([SESSION_OK, { status: 200, body: JSON.stringify({ lots: [LOT] }) }]);
    const bridge = await freshBridge('ws-demo-a');
    const fresh = await bridge.listSupplyLots();
    expect(fresh.status).toBe('OK');

    // 2. Every later call fails.
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    const stale = await bridge.listSupplyLots();
    expect(stale.status).toBe('STALE');
    expect(stale.stale).toBe(true);
    expect(stale.lots.map((l) => l.id)).toEqual(['lot-w-01']);
    expect(stale.message).toMatch(/bản đã lưu/i);

    // 3. A stale revision is not evidence a proposal is still valid.
    const proposal = bridge.proposeBooking({
      lotId: 'lot-w-01',
      quantity: 10,
      expectedRevision: LOT.revision,
    });
    expect(proposal.status).toBe('REJECTED');
    const quote = () => bridge.quoteBooking({ lotId: 'lot-w-01', quantity: 10 });
    expect(quote).toThrow(/Không tìm thấy lô hoa kiểng/);
  });

  it('a failed refresh drops a staged proposal instead of keeping it live', async () => {
    stubFetch([SESSION_OK, { status: 200, body: JSON.stringify({ lots: [LOT] }) }]);
    const bridge = await freshBridge('ws-demo-a');
    await bridge.listSupplyLots();

    const staged = bridge.proposeBooking({
      lotId: 'lot-w-01',
      quantity: 10,
      expectedRevision: LOT.revision,
    });
    expect(staged.status).toBe('STAGED_FOR_HUMAN_CONFIRMATION');
    expect(bridge.getStagedProposal()).not.toBeNull();

    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const stale = await bridge.listSupplyLots();

    expect(stale.status).toBe('STALE');
    // A proposal is an offer about a revision; a revision that could not be
    // refreshed is not evidence that the offer still stands.
    expect(bridge.getStagedProposal()).toBeNull();
  });

  it('recovers: a successful refresh clears the stale mark', async () => {
    stubFetch([SESSION_OK, { status: 200, body: JSON.stringify({ lots: [LOT] }) }]);
    const bridge = await freshBridge('ws-demo-a');
    await bridge.listSupplyLots();

    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect((await bridge.listSupplyLots()).status).toBe('STALE');

    stubFetch([SESSION_OK, { status: 200, body: JSON.stringify({ lots: [LOT] }) }]);
    const healed = await bridge.listSupplyLots();
    expect(healed.status).toBe('OK');
    expect(healed.stale).toBe(false);
    // Fresh again, so a proposal is allowed through to the server's own checks.
    expect(
      bridge.proposeBooking({ lotId: 'lot-w-01', quantity: 10, expectedRevision: LOT.revision })
        .status,
    ).toBe('STAGED_FOR_HUMAN_CONFIRMATION');
  });
});

describe('switching workspace discards the previous workspace’s state', () => {
  it('clears the cache and the staged proposal, and refetches for the new one', async () => {
    const calls = stubFetch([
      SESSION_OK,
      { status: 200, body: JSON.stringify({ lots: [LOT] }) },
    ]);
    const first = await freshBridge('ws-demo-a');
    await first.listSupplyLots();
    expect(
      first.proposeBooking({ lotId: 'lot-w-01', quantity: 10, expectedRevision: LOT.revision })
        .status,
    ).toBe('STAGED_FOR_HUMAN_CONFIRMATION');

    // A different workspace: the cached lots and the staged proposal belong to
    // the old one.
    const second = initAgentBridge('ws-demo-b'); // same module: the switch is the point
    expect(second.getStagedProposal()).toBeNull();
    expect(() => second.quoteBooking({ lotId: 'lot-w-01', quantity: 10 })).toThrow();

    await second.listSupplyLots();
    expect(calls.calls.some((url) => url.includes('workspace_id=ws-demo-b'))).toBe(true);
  });
});
