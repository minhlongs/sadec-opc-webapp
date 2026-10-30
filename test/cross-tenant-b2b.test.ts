import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { setMembershipStore, setVerifier } from '../src/worker/index.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';

/**
 * Record-level scope on the B2B handlers, through the real fetch handler.
 *
 * These pin the three writable B2B routes that take a bare record id and used
 * to reach the data layer without one: deposit confirmation, Hub package
 * verification and settlement confirmation. Each test gives the founder a
 * membership that is real but *not* a party to the record, which is the case a
 * route-level permission check cannot catch: they are allowed to be a founder,
 * they are simply not allowed to touch this booking.
 *
 * A record the caller may not see is answered 404, the same as one that does
 * not exist, so a probe cannot learn which ids are real.
 */

const ORIGIN = 'https://pilot.example.test';
const CTX: { access?: unknown } = {};

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

describe('B2B record scope follows the parties, not the workspace selector', () => {
  let harness: ReturnType<typeof createSqliteD1>;
  const env = (identity: string): Record<string, unknown> => ({
    APP_ENV: 'development',
    DEV_IDENTITY: identity,
    DB: harness.db,
  });

  /** A booking awaiting deposit, owned by ws-demo-a (buyer) and ws-demo-c (nursery). */
  function seedPendingBooking(): string {
    harness.raw
      .prepare(
        `INSERT INTO b2b_bookings (
           id, booking_code, lot_id, nursery_workspace_id, buyer_workspace_id,
           buyer_shop_name, buyer_contact_phone, destination_market,
           quantity, unit_price_vnd, gross_total_vnd, deposit_rate_bps,
           deposit_required_vnd, deposit_paid_vnd, platform_fee_bps, platform_fee_vnd,
           status, note, created_at, updated_at
         ) VALUES (
           'bk-scope-01', 'SDEC-BK-SCOPE', 'lot-w-01', 'ws-demo-c', 'ws-demo-a',
           'Shop Kiểm Thử', '0900000777', 'Chợ Kiểm Thử',
           10, 220000, 2200000, 3000,
           660000, 0, 300, 66000,
           'BOOKED_PENDING_DEPOSIT', NULL, '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z'
         )`,
      )
      .run();
    return 'bk-scope-01';
  }

  function revokeAdminOutside(workspaceIds: readonly string[]): void {
    const stmt = harness.raw.prepare(
      "UPDATE memberships SET revoked_at = '2026-10-29T12:00:00.000Z' WHERE identity_id = 'id-demo-admin' AND workspace_id = ?",
    );
    for (const id of workspaceIds) stmt.run(id);
  }

  function ledgerRows(bookingId: string): number {
    const row = harness.raw
      .prepare('SELECT COUNT(*) AS total FROM escrow_ledger_entries WHERE booking_id = ?')
      .get(bookingId) as { total: number };
    return Number(row.total);
  }

  function auditRows(action: string): number {
    const row = harness.raw
      .prepare('SELECT COUNT(*) AS total FROM audit_events WHERE action = ?')
      .get(action) as { total: number };
    return Number(row.total);
  }

  beforeEach(() => {
    harness = createSqliteD1({ seedDemo: true });
    setMembershipStore(null);
    setVerifier(null);
  });

  afterEach(() => {
    setMembershipStore(null);
    setVerifier(null);
  });

  it('confirming a deposit needs a right on a party workspace, not just any founder seat', async () => {
    const bookingId = seedPendingBooking();
    // The founder keeps ws-demo-b only; the booking's parties are a and c.
    revokeAdminOutside(['ws-demo-a', 'ws-demo-c', 'ws-shop-q1', 'ws-shop-damsen']);

    const denied = await worker.fetch(
      post('/api/b2b/bookings/confirm-deposit', 'ws-demo-b', { booking_id: bookingId, vietqr_ref: 'FT-X' }),
      env('demo-admin'),
      CTX,
    );
    expect(denied.status).toBe(404);
    expect(((await denied.json()) as { code?: string }).code).toBe('not_found');
    expect(ledgerRows(bookingId)).toBe(0);
    expect(auditRows('marketplace.escrow.deposit_confirmed')).toBe(0);
    const untouched = harness.raw
      .prepare('SELECT status, deposit_paid_vnd FROM b2b_bookings WHERE id = ?')
      .get(bookingId) as { status: string; deposit_paid_vnd: number };
    expect(untouched.status).toBe('BOOKED_PENDING_DEPOSIT');
    expect(Number(untouched.deposit_paid_vnd)).toBe(0);

    // Grant the buyer's workspace back: the same call now lands once.
    harness.raw
      .prepare("UPDATE memberships SET revoked_at = NULL WHERE id = 'mb-demo-admin-a'")
      .run();
    const allowed = await worker.fetch(
      post('/api/b2b/bookings/confirm-deposit', 'ws-demo-a', { booking_id: bookingId, vietqr_ref: 'FT-X' }),
      env('demo-admin'),
      CTX,
    );
    expect(allowed.status).toBe(200);
    expect(ledgerRows(bookingId)).toBe(1);
    expect(auditRows('marketplace.escrow.deposit_confirmed')).toBe(1);
  });

  it('verifying a Hub package needs a right on the booking it loads', async () => {
    // bk-demo-02 is ESCROW_HELD with both parties in ws-demo-a.
    revokeAdminOutside(['ws-demo-a', 'ws-demo-c', 'ws-shop-q1', 'ws-shop-damsen']);

    const denied = await worker.fetch(
      post('/api/b2b/hub-packages/verify', 'ws-demo-b', {
        trip_id: 'trip-demo-01',
        booking_id: 'bk-demo-02',
        package_label: 'Kiện thử',
      }),
      env('demo-admin'),
      CTX,
    );
    expect(denied.status).toBe(404);
    expect(auditRows('hub.package.verified')).toBe(0);
    // The shared truck's capacity is untouched by a refused load.
    const trip = harness.raw
      .prepare('SELECT loaded_units FROM hub_dispatch_trips WHERE id = ?')
      .get('trip-demo-01') as { loaded_units: number };
    expect(Number(trip.loaded_units)).toBe(30);
    const packages = harness.raw
      .prepare('SELECT COUNT(*) AS total FROM shipment_packages WHERE booking_id = ?')
      .get('bk-demo-02') as { total: number };
    expect(Number(packages.total)).toBe(0);
  });

  it('confirming a settlement needs a right on the booking, and refuses without a balance reference', async () => {
    // Inspect bk-demo-01 as the founder (a party to it), producing obligations.
    const inspected = await worker.fetch(
      post('/api/b2b/bookings/inspect-and-settle', 'ws-demo-a', {
        booking_id: 'bk-demo-01',
        accepted_units: 30,
        defective_units: 0,
        fault_party: 'NONE',
      }),
      env('demo-admin'),
      CTX,
    );
    expect(inspected.status).toBe(200);
    const inspectedBody = (await inspected.json()) as {
      settlement: { buyerBalanceRequiredVnd: number };
      settlement_record: { status: string };
    };
    // The obligation exists; no cash has moved.
    expect(inspectedBody.settlement.buyerBalanceRequiredVnd).toBeGreaterThan(0);
    expect(inspectedBody.settlement_record.status).toBe('AWAITING_BALANCE');
    expect(ledgerRows('bk-demo-01')).toBe(1); // the seeded deposit only

    // A founder with no right on the parties cannot confirm it.
    revokeAdminOutside(['ws-demo-a', 'ws-demo-c', 'ws-shop-q1', 'ws-shop-damsen']);
    const denied = await worker.fetch(
      post('/api/b2b/bookings/confirm-settlement', 'ws-demo-b', {
        booking_id: 'bk-demo-01',
        balance_ref: 'FT-BAL-1',
      }),
      env('demo-admin'),
      CTX,
    );
    expect(denied.status).toBe(404);
    expect(auditRows('marketplace.escrow.settlement_confirmed')).toBe(0);
    expect(ledgerRows('bk-demo-01')).toBe(1);

    // With the right restored, a missing reference is still refused: the
    // balance is claimed as received, so it must name what was checked.
    harness.raw
      .prepare("UPDATE memberships SET revoked_at = NULL WHERE id = 'mb-demo-admin-a'")
      .run();
    const noRef = await worker.fetch(
      post('/api/b2b/bookings/confirm-settlement', 'ws-demo-a', { booking_id: 'bk-demo-01' }),
      env('demo-admin'),
      CTX,
    );
    expect(noRef.status).toBe(400);
    expect(((await noRef.json()) as { code?: string }).code).toBe('validation');

    const confirmed = await worker.fetch(
      post('/api/b2b/bookings/confirm-settlement', 'ws-demo-a', {
        booking_id: 'bk-demo-01',
        balance_ref: 'FT-BAL-1',
      }),
      env('demo-admin'),
      CTX,
    );
    expect(confirmed.status).toBe(200);
    expect(auditRows('marketplace.escrow.settlement_confirmed')).toBe(1);

    // Releasing twice is a conflict, not a second set of ledger rows.
    const again = await worker.fetch(
      post('/api/b2b/bookings/confirm-settlement', 'ws-demo-a', {
        booking_id: 'bk-demo-01',
        balance_ref: 'FT-BAL-1',
      }),
      env('demo-admin'),
      CTX,
    );
    expect(again.status).toBe(409);
    expect(auditRows('marketplace.escrow.settlement_confirmed')).toBe(1);
  });

  it('the Hub list shares the truck but not the packages on it', async () => {
    // An outsider: a membership in ws-shop-q1 only, party to neither booking.
    harness.raw
      .prepare(
        `INSERT INTO identities (id, access_sub, email, display_name, created_at)
         VALUES ('id-outside', 'probe:sub:outside', 'outside@example.test', 'Ngoài phạm vi', '2026-10-29T00:00:00.000Z')`,
      )
      .run();
    harness.raw
      .prepare(
        `INSERT INTO memberships (id, identity_id, workspace_id, role, granted_by, granted_at)
         VALUES ('mb-outside', 'id-outside', 'ws-demo-b', 'workspace_operator', 'id-demo-admin', '2026-10-29T00:00:00.000Z')`,
      )
      .run();
    setVerifier(async () => ({ accessSubject: 'probe:sub:outside', email: 'outside@example.test' }));

    const res = await worker.fetch(
      get('/api/b2b/hub-trips', 'ws-demo-b'),
      { APP_ENV: 'pilot', sadec_pilot: harness.db },
      CTX,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trips: { id: string; packages: { booking_id: string; package_qr_token: string }[] }[];
    };
    // The truck is a shared logistics resource: its schedule and capacity are
    // visible. What it carries is not.
    const trip = body.trips.find((t) => t.id === 'trip-demo-01');
    expect(trip).toBeDefined();
    expect(trip?.packages).toEqual([]);

    // And nothing on the booking list either.
    const bookings = await worker.fetch(
      get('/api/b2b/bookings', 'ws-demo-b'),
      { APP_ENV: 'pilot', sadec_pilot: harness.db },
      CTX,
    );
    expect(((await bookings.json()) as { bookings: unknown[] }).bookings).toEqual([]);
  });

  it('the shared lot catalogue carries no nursery contact details', async () => {
    const res = await worker.fetch(get('/api/b2b/lots', 'ws-shop-q1'), env('demo-operator'), CTX);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lots: Record<string, unknown>[] };
    expect(body.lots.length).toBeGreaterThan(0);
    for (const lot of body.lots) {
      for (const forbidden of ['owner_name', 'phone', 'tax_code', 'owner_phone', 'nursery_phone']) {
        expect(Object.keys(lot), forbidden).not.toContain(forbidden);
      }
    }
    // `mine=1` narrows to the workspace that asked.
    const mine = await worker.fetch(
      get('/api/b2b/lots', 'ws-shop-q1', { mine: '1' }),
      env('demo-operator'),
      CTX,
    );
    const mineBody = (await mine.json()) as { lots: { nursery_workspace_id: string }[] };
    expect(mineBody.lots.every((lot) => lot.nursery_workspace_id === 'ws-shop-q1')).toBe(true);
  });

  it('a revoked membership denies the very next request', async () => {
    const before = await worker.fetch(get('/api/orders', 'ws-demo-a'), env('demo-operator'), CTX);
    expect(before.status).toBe(200);

    harness.raw
      .prepare("UPDATE memberships SET revoked_at = '2026-10-29T13:00:00.000Z' WHERE id = 'mb-demo-op-a'")
      .run();

    const after = await worker.fetch(get('/api/orders', 'ws-demo-a'), env('demo-operator'), CTX);
    expect(after.status).toBe(403);
    const body = (await after.json()) as { code?: string; error: string };
    expect(body.code).toBe('forbidden');
    expect(body.error).toBe('Bạn không thuộc workspace này.');

    // The session answers with the remaining memberships, not the revoked one.
    const session = await worker.fetch(get('/api/session', 'ws-demo-a'), env('demo-operator'), CTX);
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as {
      session: { workspaceId: string; workspaces: { workspaceId: string }[] };
    };
    expect(sessionBody.session.workspaces.map((w) => w.workspaceId)).not.toContain('ws-demo-a');
    expect(sessionBody.session.workspaceId).not.toBe('ws-demo-a');
  });
});
