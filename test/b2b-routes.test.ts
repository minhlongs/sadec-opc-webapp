import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { setMembershipStore, setVerifier } from '../src/worker/index.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';

/**
 * The B2B routes through the real fetch handler, against SQLite running the
 * real migrations and the demo seed. Earlier versions of this file used an
 * in-memory fake whose `batch` executed nothing, which is exactly why the
 * oversell and double-write defects it is now asserting against went unseen.
 *
 * Identities are the seeded demo ones, selected per request through
 * `DEV_IDENTITY` in a development environment:
 *   demo-admin     founder_admin in every demo workspace
 *   demo-owner     workspace_owner in ws-demo-a, ws-demo-b, ws-demo-c
 *   demo-operator  workspace_operator in ws-demo-a, ws-shop-q1, ws-shop-damsen
 */

const ORIGIN = 'https://pilot.example.test';
const CTX: { access?: unknown } = {};

type Identity = 'demo-admin' | 'demo-owner' | 'demo-operator';

interface Harness {
  db: ReturnType<typeof createSqliteD1>['db'];
  raw: ReturnType<typeof createSqliteD1>['raw'];
}

/**
 * The escrow account a deployment would configure. Tests set it explicitly:
 * production code has no default, because a built-in account number would ask
 * a buyer to transfer money to an account the platform does not hold.
 */
const TEST_ESCROW = {
  ESCROW_BANK_BIN: '970415',
  ESCROW_ACCOUNT_NUMBER: '0011002233445',
  ESCROW_ACCOUNT_HOLDER: 'CONG TY THU NGHIEM',
};

function envFor(
  harness: Harness,
  identity: Identity,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { APP_ENV: 'development', DEV_IDENTITY: identity, DB: harness.db, ...TEST_ESCROW, ...overrides };
}

function makeRequest(
  path: string,
  options: {
    method?: string;
    workspaceId: string;
    secFetchSite?: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Request {
  const url = new URL(path, ORIGIN);
  url.searchParams.set('workspace_id', options.workspaceId);
  const headers: Record<string, string> = {
    'Sec-Fetch-Site': options.secFetchSite ?? 'same-origin',
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(url, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function call<T = Record<string, unknown>>(
  harness: Harness,
  identity: Identity,
  path: string,
  options: Parameters<typeof makeRequest>[1],
): Promise<{ status: number; body: T }> {
  const res = await worker.fetch(makeRequest(path, options), envFor(harness, identity), CTX);
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

const BOOKING_INPUT = {
  lot_id: 'lot-w-02', // ws-demo-a, 150 units, MOQ 15, 180,000 VND, 30% deposit
  quantity: 20,
  buyer_shop_name: 'Tiệm Hoa Sài Gòn Phố',
  buyer_contact_phone: '0903123456',
  destination_market: 'Chợ hoa Hồ Thị Kỷ, Quận 10',
};

/** A shop operator in ws-shop-q1 books lot-w-02 from ws-demo-a. */
async function bookAsShop(harness: Harness): Promise<{ id: string; status: string }> {
  const res = await call<{ booking: { id: string; status: string } }>(
    harness,
    'demo-operator',
    '/api/b2b/bookings/create',
    { workspaceId: 'ws-shop-q1', body: BOOKING_INPUT },
  );
  expect(res.status).toBe(201);
  return res.body.booking;
}

function count(harness: Harness, sql: string, ...params: (string | number)[]): number {
  const row = harness.raw.prepare(sql).get(...params) as { total: number };
  return Number(row.total);
}

describe('B2B API Routes and Security Chokepoint', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createSqliteD1({ seedDemo: true });
    setMembershipStore(null);
    setVerifier(null);
  });

  afterEach(() => {
    setMembershipStore(null);
    setVerifier(null);
  });

  it('GET /api/b2b/lots allows reading published supply lots', async () => {
    const res = await call<{ lots: { status: string }[] }>(harness, 'demo-operator', '/api/b2b/lots', {
      workspaceId: 'ws-shop-q1',
    });
    expect(res.status).toBe(200);
    expect(res.body.lots.length).toBeGreaterThan(0);
    // Sharing boundary: only published or sold-out lots are an offer to members.
    for (const lot of res.body.lots) {
      expect(['PUBLISHED', 'SOLD_OUT']).toContain(lot.status);
    }
  });

  it('POST /api/b2b/lots/create allows nursery owner to publish new lot', async () => {
    const res = await call<{ lot: { name: string; qr_lot_token: string; nursery_workspace_id: string } }>(
      harness,
      'demo-owner',
      '/api/b2b/lots/create',
      {
        workspaceId: 'ws-demo-a',
        body: {
          name: 'Mai Vàng Sa Đéc 5 Cánh',
          mode: 'SEASONAL_PREORDER',
          species: 'Ochna integerrima',
          grade: 'A',
          pot_diameter_cm: 70,
          height_cm: 120,
          canopy_cm: 90,
          bud_specification: 'Nụ mập đẫy, phân bố đều',
          media_proof_url: 'https://images.example.com/mai-01.jpg',
          unit_price_vnd: 800000,
          deposit_rate_bps: 5000,
          moq_units: 5,
          total_units: 20,
          cut_or_ship_date: '2027-01-20',
        },
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.lot.name).toBe('Mai Vàng Sa Đéc 5 Cánh');
    expect(res.body.lot.qr_lot_token.startsWith('SDECQR.')).toBe(true);
    // The nursery is the authorized workspace, never a value from the body.
    expect(res.body.lot.nursery_workspace_id).toBe('ws-demo-a');
  });

  it('POST /api/b2b/lots/create blocks cross-site mutation via Sec-Fetch-Site', async () => {
    const res = await call<{ error: string; code?: string }>(harness, 'demo-owner', '/api/b2b/lots/create', {
      workspaceId: 'ws-demo-a',
      secFetchSite: 'cross-site',
      body: { name: 'Xâm Nhập Cross Site', mode: 'WEEKLY_CATALOG' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/nguồn gửi không khớp/i);
    expect(res.body.code).toBe('forbidden');
  });

  it('POST /api/b2b/bookings/confirm-deposit only permits founder_admin', async () => {
    const booking = await bookAsShop(harness);
    expect(booking.status).toBe('BOOKED_PENDING_DEPOSIT');

    // The nursery owner is party to the booking but holds the wrong role.
    const denied = await call<{ code?: string }>(harness, 'demo-owner', '/api/b2b/bookings/confirm-deposit', {
      workspaceId: 'ws-demo-a',
      body: { booking_id: booking.id },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('forbidden');

    // The founder confirms, with the reference they saw on the bank statement.
    const allowed = await call<{ booking: { status: string; deposit_paid_vnd: number } }>(
      harness,
      'demo-admin',
      '/api/b2b/bookings/confirm-deposit',
      { workspaceId: 'ws-demo-a', body: { booking_id: booking.id, vietqr_ref: 'FT2610290001' } },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.booking.status).toBe('ESCROW_HELD');
    expect(allowed.body.booking.deposit_paid_vnd).toBe(1080000); // 20 × 180,000 × 30%

    // One ledger row, carrying the reference, and one audit event.
    expect(
      count(
        harness,
        "SELECT COUNT(*) AS total FROM escrow_ledger_entries WHERE booking_id = ? AND entry_type = 'DEPOSIT_HELD' AND vietqr_ref = 'FT2610290001'",
        booking.id,
      ),
    ).toBe(1);
    expect(
      count(
        harness,
        "SELECT COUNT(*) AS total FROM audit_events WHERE subject_id = ? AND action = 'marketplace.escrow.deposit_confirmed'",
        booking.id,
      ),
    ).toBe(1);

    // Confirming again is a state conflict, not a second ledger row.
    const again = await call<{ code?: string }>(harness, 'demo-admin', '/api/b2b/bookings/confirm-deposit', {
      workspaceId: 'ws-demo-a',
      body: { booking_id: booking.id },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_state');
    expect(
      count(harness, 'SELECT COUNT(*) AS total FROM escrow_ledger_entries WHERE booking_id = ?', booking.id),
    ).toBe(1);
  });

  it('GET /api/b2b/pilot-dashboard returns KPI metrics to founder_admin', async () => {
    const res = await call<{ metrics: { verifiedNurseriesCount: number; isLedgerBalanced: boolean } }>(
      harness,
      'demo-admin',
      '/api/b2b/pilot-dashboard',
      { workspaceId: 'ws-demo-a' },
    );
    expect(res.status).toBe(200);
    expect(res.body.metrics.verifiedNurseriesCount).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.metrics.isLedgerBalanced).toBe('boolean');

    const operator = await call(harness, 'demo-operator', '/api/b2b/pilot-dashboard', {
      workspaceId: 'ws-demo-a',
    });
    expect(operator.status).toBe(403);
  });
});

describe('a booking is shared with its two parties and nobody else', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createSqliteD1({ seedDemo: true });
    setMembershipStore(null);
    setVerifier(null);
  });

  afterEach(() => {
    setMembershipStore(null);
    setVerifier(null);
  });

  it('lists the booking to the buyer and the nursery, and hides it from a third workspace', async () => {
    const booking = await bookAsShop(harness);

    const buyer = await call<{ bookings: { id: string }[] }>(harness, 'demo-operator', '/api/b2b/bookings', {
      workspaceId: 'ws-shop-q1',
    });
    expect(buyer.body.bookings.map((b) => b.id)).toContain(booking.id);

    const nursery = await call<{ bookings: { id: string }[] }>(harness, 'demo-owner', '/api/b2b/bookings', {
      workspaceId: 'ws-demo-a',
    });
    expect(nursery.body.bookings.map((b) => b.id)).toContain(booking.id);

    // ws-demo-b is a nursery with no part in this booking.
    const stranger = await call<{ bookings: { id: string }[] }>(harness, 'demo-owner', '/api/b2b/bookings', {
      workspaceId: 'ws-demo-b',
    });
    expect(stranger.status).toBe(200);
    expect(stranger.body.bookings.map((b) => b.id)).not.toContain(booking.id);
  });

  it('answers 404 to a founder acting from a workspace that is not a party, and never leaks existence', async () => {
    const booking = await bookAsShop(harness);
    // The founder holds founder_admin everywhere in the seed, so revoke the two
    // party memberships to model a founder who does not administer them.
    harness.raw
      .prepare("UPDATE memberships SET revoked_at = '2026-10-29T00:00:00.000Z' WHERE id IN ('mb-demo-admin-a', 'mb-demo-admin-q1')")
      .run();

    const res = await call<{ code?: string; error: string }>(harness, 'demo-admin', '/api/b2b/bookings/confirm-deposit', {
      workspaceId: 'ws-demo-b',
      body: { booking_id: booking.id },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect(res.body.error).not.toContain(booking.id);
    expect(count(harness, 'SELECT COUNT(*) AS total FROM escrow_ledger_entries WHERE booking_id = ?', booking.id)).toBe(0);
  });

  it('denies every request once the membership it relied on is revoked', async () => {
    const before = await call(harness, 'demo-operator', '/api/b2b/bookings', { workspaceId: 'ws-shop-q1' });
    expect(before.status).toBe(200);

    harness.raw
      .prepare("UPDATE memberships SET revoked_at = '2026-10-29T00:00:00.000Z' WHERE id = 'mb-demo-op-q1'")
      .run();

    const after = await call<{ code?: string }>(harness, 'demo-operator', '/api/b2b/bookings', {
      workspaceId: 'ws-shop-q1',
    });
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('forbidden');
  });
});

describe('a deposit QR exists only when an account is configured', () => {
  it('returns null and says so, instead of pointing at a built-in account number', async () => {
    const harness = createSqliteD1({ seedDemo: true });
    const env = envFor(harness, 'demo-operator', {
      ESCROW_BANK_BIN: '',
      ESCROW_ACCOUNT_NUMBER: '',
      ESCROW_ACCOUNT_HOLDER: '',
    });
    const res = await worker.fetch(
      makeRequest('/api/b2b/bookings/create', { workspaceId: 'ws-shop-q1', body: BOOKING_INPUT }),
      env,
      CTX,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { booking: { id: string; deposit_required_vnd: number }; deposit_vietqr: unknown };
    expect(body.deposit_vietqr).toBeNull();
    expect(body.booking.deposit_required_vnd).toBeGreaterThan(0);

    // The booking is real and readable; only the payment instruction is absent.
    const listed = await worker.fetch(
      makeRequest('/api/b2b/bookings', { workspaceId: 'ws-shop-q1' }),
      env,
      CTX,
    );
    expect(listed.status).toBe(200);
    const { bookings } = (await listed.json()) as { bookings: Array<{ id: string; deposit_vietqr: unknown }> };
    expect(bookings.find((b) => b.id === body.booking.id)?.deposit_vietqr).toBeNull();
  });
});

describe('hub dispatch and settlement write only what their conditions allow', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createSqliteD1({ seedDemo: true });
    setMembershipStore(null);
    setVerifier(null);
  });

  afterEach(() => {
    setMembershipStore(null);
    setVerifier(null);
  });

  async function escrowHeldBooking(): Promise<string> {
    const booking = await bookAsShop(harness);
    const confirmed = await call(harness, 'demo-admin', '/api/b2b/bookings/confirm-deposit', {
      workspaceId: 'ws-demo-a',
      body: { booking_id: booking.id, vietqr_ref: 'FT-DEP-1' },
    });
    expect(confirmed.status).toBe(200);
    return booking.id;
  }

  it('creates a hub trip (founder only) and loads a package once, within capacity', async () => {
    const bookingId = await escrowHeldBooking();

    const deniedTrip = await call(harness, 'demo-owner', '/api/b2b/hub-trips/create', {
      workspaceId: 'ws-demo-a',
      body: {
        truck_plate: '66C-001.02',
        driver_name: 'Anh Bảy',
        driver_phone: '0900000302',
        departure_sa_dec_at: '2026-11-01T21:00:00.000Z',
        eta_hcm_at: '2026-11-02T03:00:00.000Z',
        destination_market: 'Chợ Hồ Thị Kỷ',
        capacity_units: 25,
      },
    });
    expect(deniedTrip.status).toBe(403);

    const trip = await call<{ trip: { id: string; status: string; loaded_units: number } }>(
      harness,
      'demo-admin',
      '/api/b2b/hub-trips/create',
      {
        workspaceId: 'ws-demo-a',
        body: {
          truck_plate: '66C-001.02',
          driver_name: 'Anh Bảy',
          driver_phone: '0900000302',
          departure_sa_dec_at: '2026-11-01T21:00:00.000Z',
          eta_hcm_at: '2026-11-02T03:00:00.000Z',
          destination_market: 'Chợ Hồ Thị Kỷ',
          capacity_units: 25,
        },
      },
    );
    expect(trip.status).toBe(201);
    expect(trip.body.trip.status).toBe('GATHERING');

    const verified = await call<{ package: { units_count: number; hub_inspection_status: string } }>(
      harness,
      'demo-admin',
      '/api/b2b/hub-packages/verify',
      {
        workspaceId: 'ws-demo-a',
        body: { trip_id: trip.body.trip.id, booking_id: bookingId, package_label: 'Kiện #01' },
      },
    );
    expect(verified.status).toBe(201);
    expect(verified.body.package.units_count).toBe(20);
    expect(verified.body.package.hub_inspection_status).toBe('VERIFIED_OK');

    const tripRow = harness.raw
      .prepare('SELECT loaded_units FROM hub_dispatch_trips WHERE id = ?')
      .get(trip.body.trip.id) as { loaded_units: number };
    expect(tripRow.loaded_units).toBe(20);

    // The same booking cannot be loaded twice: its status moved on, and the
    // package row is UNIQUE per booking. Nothing changes on the trip.
    const twice = await call<{ code?: string }>(harness, 'demo-admin', '/api/b2b/hub-packages/verify', {
      workspaceId: 'ws-demo-a',
      body: { trip_id: trip.body.trip.id, booking_id: bookingId, package_label: 'Kiện #01 lặp' },
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('invalid_state');
    expect(count(harness, 'SELECT COUNT(*) AS total FROM shipment_packages WHERE booking_id = ?', bookingId)).toBe(1);

    // A second booking of 20 does not fit the remaining 5: refused in Vietnamese,
    // no SQL constraint text, and loaded_units stays at 20.
    const second = await escrowHeldBooking();
    const overflow = await call<{ code?: string; error: string }>(harness, 'demo-admin', '/api/b2b/hub-packages/verify', {
      workspaceId: 'ws-demo-a',
      body: { trip_id: trip.body.trip.id, booking_id: second, package_label: 'Kiện #02' },
    });
    expect(overflow.status).toBe(409);
    expect(overflow.body.error).toMatch(/sức chứa/);
    expect(overflow.body.error).not.toMatch(/CHECK|constraint|SQLITE/i);
    const after = harness.raw
      .prepare('SELECT loaded_units FROM hub_dispatch_trips WHERE id = ?')
      .get(trip.body.trip.id) as { loaded_units: number };
    expect(after.loaded_units).toBe(20);
  });

  it('inspection records obligations without touching the ledger; the founder confirms the cash later', async () => {
    const bookingId = await escrowHeldBooking();

    // Not yet consolidated: nothing to inspect.
    const early = await call<{ code?: string }>(harness, 'demo-operator', '/api/b2b/bookings/inspect-and-settle', {
      workspaceId: 'ws-shop-q1',
      body: { booking_id: bookingId, accepted_units: 20, defective_units: 0, fault_party: 'NONE' },
    });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('invalid_state');

    const trip = await call<{ trip: { id: string } }>(harness, 'demo-admin', '/api/b2b/hub-trips/create', {
      workspaceId: 'ws-demo-a',
      body: {
        truck_plate: '66C-001.03',
        driver_name: 'Anh Tám',
        driver_phone: '0900000303',
        departure_sa_dec_at: '2026-11-01T21:00:00.000Z',
        eta_hcm_at: '2026-11-02T03:00:00.000Z',
        destination_market: 'Chợ Hồ Thị Kỷ',
        capacity_units: 100,
      },
    });
    const loaded = await call(harness, 'demo-admin', '/api/b2b/hub-packages/verify', {
      workspaceId: 'ws-demo-a',
      body: { trip_id: trip.body.trip.id, booking_id: bookingId, package_label: 'Kiện #01' },
    });
    expect(loaded.status).toBe(201);

    // The nursery is party to the booking but is not the one receiving goods.
    const nurseryTries = await call<{ code?: string }>(harness, 'demo-owner', '/api/b2b/bookings/inspect-and-settle', {
      workspaceId: 'ws-demo-a',
      body: { booking_id: bookingId, accepted_units: 20, defective_units: 0, fault_party: 'NONE' },
    });
    expect(nurseryTries.status).toBe(403);

    // The buyer inspects: 18 good, 2 defective, nursery at fault.
    const inspected = await call<{
      booking: { status: string };
      settlement: {
        buyerBalanceRequiredVnd: number;
        nurseryPayoutVnd: number;
        platformFeeRetainedVnd: number;
        buyerRefundVnd: number;
        buyerTotalObligationVnd: number;
      };
      settlement_record: { status: string; balance_collected_vnd: number };
      balance_vietqr: unknown;
    }>(harness, 'demo-operator', '/api/b2b/bookings/inspect-and-settle', {
      workspaceId: 'ws-shop-q1',
      body: { booking_id: bookingId, accepted_units: 18, defective_units: 2, fault_party: 'NURSERY' },
    });
    expect(inspected.status).toBe(200);
    expect(inspected.body.booking.status).toBe('INSPECTED_PARTIAL_DEFECT');
    // 18 × 180,000 = 3,240,000 accepted; fee 3% = 97,200; obligation 3,337,200;
    // deposit 1,080,000 confirmed → balance receivable 2,257,200.
    expect(inspected.body.settlement.nurseryPayoutVnd).toBe(3240000);
    expect(inspected.body.settlement.platformFeeRetainedVnd).toBe(97200);
    expect(inspected.body.settlement.buyerBalanceRequiredVnd).toBe(2257200);
    expect(inspected.body.settlement.buyerRefundVnd).toBe(0);
    expect(inspected.body.settlement.buyerTotalObligationVnd).toBe(3337200);
    expect(inspected.body.settlement_record.status).toBe('AWAITING_BALANCE');
    expect(inspected.body.settlement_record.balance_collected_vnd).toBe(0);
    expect(inspected.body.balance_vietqr).not.toBeNull();

    // Nothing but the deposit is in the ledger: no money has been confirmed.
    expect(count(harness, 'SELECT COUNT(*) AS total FROM escrow_ledger_entries WHERE booking_id = ?', bookingId)).toBe(1);

    // Inspecting twice is refused and leaves one settlement row.
    const twice = await call<{ code?: string }>(harness, 'demo-operator', '/api/b2b/bookings/inspect-and-settle', {
      workspaceId: 'ws-shop-q1',
      body: { booking_id: bookingId, accepted_units: 20, defective_units: 0, fault_party: 'NONE' },
    });
    expect(twice.status).toBe(409);
    expect(count(harness, 'SELECT COUNT(*) AS total FROM b2b_settlements WHERE booking_id = ?', bookingId)).toBe(1);

    // A buyer cannot confirm the cash; the founder must, and needs a reference.
    const buyerConfirms = await call(harness, 'demo-operator', '/api/b2b/bookings/confirm-settlement', {
      workspaceId: 'ws-shop-q1',
      body: { booking_id: bookingId, balance_ref: 'FT-BAL-1' },
    });
    expect(buyerConfirms.status).toBe(403);

    const noRef = await call<{ code?: string }>(harness, 'demo-admin', '/api/b2b/bookings/confirm-settlement', {
      workspaceId: 'ws-demo-a',
      body: { booking_id: bookingId },
    });
    expect(noRef.status).toBe(400);
    expect(noRef.body.code).toBe('validation');
    expect(count(harness, 'SELECT COUNT(*) AS total FROM escrow_ledger_entries WHERE booking_id = ?', bookingId)).toBe(1);

    const confirmed = await call<{
      booking: { status: string; platform_fee_vnd: number };
      settlement_record: { status: string; balance_collected_vnd: number; balance_collected_ref: string };
    }>(harness, 'demo-admin', '/api/b2b/bookings/confirm-settlement', {
      workspaceId: 'ws-demo-a',
      body: { booking_id: bookingId, balance_ref: 'FT-BAL-1' },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.booking.status).toBe('SETTLED');
    expect(confirmed.body.booking.platform_fee_vnd).toBe(97200);
    expect(confirmed.body.settlement_record.status).toBe('RELEASED');
    expect(confirmed.body.settlement_record.balance_collected_vnd).toBe(2257200);
    expect(confirmed.body.settlement_record.balance_collected_ref).toBe('FT-BAL-1');

    // Ledger: deposit + balance in; payout + fee out; deduction recorded; no refund row.
    const rows = harness.raw
      .prepare('SELECT entry_type, amount_vnd, vietqr_ref FROM escrow_ledger_entries WHERE booking_id = ? ORDER BY entry_type')
      .all(bookingId) as { entry_type: string; amount_vnd: number; vietqr_ref: string | null }[];
    expect(rows.map((r) => [r.entry_type, r.amount_vnd])).toEqual([
      ['BALANCE_COLLECTED', 2257200],
      ['DEFECT_DEDUCTION', 360000],
      ['DEPOSIT_HELD', 1080000],
      ['NURSERY_PAYOUT_RELEASED', 3240000],
      ['PLATFORM_FEE_RETAINED', 97200],
    ]);
    expect(rows.find((r) => r.entry_type === 'BALANCE_COLLECTED')?.vietqr_ref).toBe('FT-BAL-1');

    // Inflow equals outflow, so the dashboard reports the ledger balanced.
    const dashboard = await call<{ metrics: { unbalancedSettledBookingsCount: number; totalPlatformOutlayVnd: number; isLedgerBalanced: boolean } }>(
      harness,
      'demo-admin',
      '/api/b2b/pilot-dashboard',
      { workspaceId: 'ws-demo-a' },
    );
    expect(dashboard.body.metrics.unbalancedSettledBookingsCount).toBe(0);
    expect(dashboard.body.metrics.totalPlatformOutlayVnd).toBe(0);
    expect(dashboard.body.metrics.isLedgerBalanced).toBe(true);

    // Confirming a second time is a conflict and writes no further rows.
    const again = await call<{ code?: string }>(harness, 'demo-admin', '/api/b2b/bookings/confirm-settlement', {
      workspaceId: 'ws-demo-a',
      body: { booking_id: bookingId, balance_ref: 'FT-BAL-1' },
    });
    expect(again.status).toBe(409);
    expect(count(harness, 'SELECT COUNT(*) AS total FROM escrow_ledger_entries WHERE booking_id = ?', bookingId)).toBe(5);
  });

  it('the dashboard reports an outlay when a ledger has more out than in', async () => {
    // Model a ledger written under the old rule, where a payout was recorded
    // without the balance ever being confirmed, on a released settlement.
    const bookingId = await escrowHeldBooking();
    const now = '2026-10-29T10:00:00.000Z';
    harness.raw
      .prepare(
        `INSERT INTO b2b_settlements (id, booking_id, buyer_workspace_id, nursery_workspace_id, accepted_units, defective_units, fault_party,
           accepted_value_vnd, nursery_deduction_vnd, platform_fee_vnd, deposit_paid_vnd, buyer_balance_required_vnd, buyer_refund_vnd, nursery_payout_vnd,
           balance_collected_vnd, status, inspected_by, inspected_at, released_by, released_at, created_at, updated_at)
         VALUES ('stl-x', ?, 'ws-shop-q1', 'ws-demo-a', 20, 0, 'NONE', 3600000, 0, 108000, 1080000, 2628000, 0, 3600000,
           0, 'RELEASED', 'id-demo-operator', ?, 'id-demo-admin', ?, ?, ?)`,
      )
      .run(bookingId, now, now, now, now);
    harness.raw
      .prepare(
        `INSERT INTO escrow_ledger_entries (id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at)
         VALUES ('led-x', ?, 'NURSERY_PAYOUT_RELEASED', 3600000, NULL, 'ghi nhận cũ', ?)`,
      )
      .run(bookingId, now);

    const dashboard = await call<{ metrics: { unbalancedSettledBookingsCount: number; totalPlatformOutlayVnd: number; isLedgerBalanced: boolean } }>(
      harness,
      'demo-admin',
      '/api/b2b/pilot-dashboard',
      { workspaceId: 'ws-demo-a' },
    );
    expect(dashboard.body.metrics.unbalancedSettledBookingsCount).toBe(1);
    expect(dashboard.body.metrics.totalPlatformOutlayVnd).toBe(3600000 - 1080000);
    expect(dashboard.body.metrics.isLedgerBalanced).toBe(false);
  });
});
