import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, {
  setMembershipStore,
  setVerifier,
  type Verifier,
} from '../src/worker/index.ts';
import type { MembershipStore, Role } from '../src/security/authorize.ts';
import type { D1Like } from '../src/ops/catalog.ts';

const ORIGIN = 'https://pilot.example.test';
const CTX: { access?: unknown } = {};

interface FakeD1Store {
  lots: Record<string, unknown>[];
  bookings: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
  trips: Record<string, unknown>[];
  packages: Record<string, unknown>[];
  nurseries: Record<string, unknown>[];
}

function createInMemoryD1(): { db: D1Like; store: FakeD1Store } {
  const store: FakeD1Store = {
    lots: [
      {
        id: 'lot-01',
        lot_code: 'SDEC-LOT-1001',
        nursery_workspace_id: 'ws-demo-a',
        name: 'Cúc Mâm Xôi Vàng Sa Đéc',
        mode: 'WEEKLY_CATALOG',
        species: 'Chrysanthemum morifolium',
        grade: 'A',
        pot_diameter_cm: 60,
        height_cm: 75,
        canopy_cm: 65,
        bud_specification: '100% nụ đều',
        media_proof_url: 'https://images.example.com/cuc-01.jpg',
        unit: 'chậu',
        unit_price_vnd: 200000,
        deposit_rate_bps: 4000,
        moq_units: 10,
        total_units: 100,
        available_units: 100,
        cut_or_ship_date: '2026-11-01',
        qr_lot_token: 'SDECQR.demo.lot.01',
        status: 'PUBLISHED',
        created_at: '2026-10-25T08:00:00.000Z',
        updated_at: '2026-10-25T08:00:00.000Z',
      },
    ],
    bookings: [
      {
        id: 'bk-01',
        booking_code: 'SDEC-BK-1001',
        lot_id: 'lot-01',
        nursery_workspace_id: 'ws-demo-a',
        buyer_workspace_id: 'ws-shop-a',
        buyer_shop_name: 'Tiệm Hoa Sài Gòn Phố',
        buyer_contact_phone: '0903123456',
        destination_market: 'Chợ hoa Hồ Thị Kỷ, Quận 10',
        quantity: 50,
        unit_price_vnd: 200000,
        gross_total_vnd: 10000000,
        deposit_rate_bps: 4000,
        deposit_required_vnd: 4000000,
        deposit_paid_vnd: 4000000,
        platform_fee_bps: 300,
        platform_fee_vnd: 300000,
        status: 'BOOKED_PENDING_DEPOSIT',
        note: null,
        created_at: '2026-10-25T08:00:00.000Z',
        updated_at: '2026-10-25T08:00:00.000Z',
      },
    ],
    ledger: [
      {
        id: 'led-01',
        booking_id: 'bk-01',
        entry_type: 'DEPOSIT_HELD',
        amount_vnd: 4000000,
        vietqr_ref: 'SDEC DEP SDEC-BK-1001',
        note: 'Tiền cọc 40% VietQR',
        created_at: '2026-10-25T08:00:00.000Z',
      },
    ],
    trips: [
      {
        id: 'trip-01',
        trip_code: 'SDEC-TRIP-2001',
        truck_plate: '66C-123.45',
        driver_name: 'Trần Văn Vận',
        driver_phone: '0918112233',
        departure_sa_dec_at: '2026-10-26T02:00:00.000Z',
        eta_hcm_at: '2026-10-26T06:30:00.000Z',
        destination_market: 'Chợ đầu mối Hồ Thị Kỷ',
        capacity_units: 500,
        loaded_units: 50,
        status: 'LOADING',
        created_at: '2026-10-25T08:00:00.000Z',
        updated_at: '2026-10-25T08:00:00.000Z',
      },
    ],
    packages: [],
    nurseries: [
      {
        id: 'nur-01',
        workspace_id: 'ws-demo-a',
        nursery_name: 'Vườn Kiểng Út Thắng',
        hamlet_area: 'Tân Quy Đông, TP. Sa Đéc',
        owner_name: 'Nguyễn Văn Thắng',
        phone: '0918123456',
        specialties_json: '["Cúc mâm xôi"]',
        verified_status: 'VERIFIED',
        fulfillment_score_bps: 9800,
        created_at: '2026-10-25T08:00:00.000Z',
        updated_at: '2026-10-25T08:00:00.000Z',
      },
    ],
  };

  const db: D1Like = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (/FROM supply_lots.*WHERE id = \?/i.test(query)) {
                const id = params[0];
                const item = store.lots.find((l) => l.id === id);
                return (item as T) ?? null;
              }
              if (/FROM b2b_bookings.*WHERE id = \?/i.test(query)) {
                const id = params[0];
                const item = store.bookings.find((b) => b.id === id);
                return (item as T) ?? null;
              }
              if (/FROM shipment_packages.*WHERE id = \?/i.test(query)) {
                const id = params[0];
                const item = store.packages.find((p) => p.id === id);
                return (item as T) ?? null;
              }
              if (/COUNT\(\*\) AS total FROM nursery_profiles/i.test(query)) {
                return { total: store.nurseries.length } as T;
              }
              if (/COUNT\(DISTINCT buyer_workspace_id\) AS total FROM b2b_bookings/i.test(query)) {
                return { total: 1 } as T;
              }
              if (/COUNT\(\*\) AS total FROM b2b_bookings WHERE status IN/i.test(query)) {
                const settled = store.bookings.filter((b) =>
                  ['SETTLED', 'INSPECTED_ACCEPTED', 'INSPECTED_PARTIAL_DEFECT'].includes(
                    String(b.status),
                  ),
                );
                return { total: settled.length } as T;
              }
              if (/SELECT COUNT\(\*\) AS total FROM \(.*GROUP BY buyer_workspace_id/i.test(query)) {
                return { total: 0 } as T;
              }
              return null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              if (/FROM supply_lots l/i.test(query)) {
                const lotsWithNursery = store.lots.map((l) => {
                  const n = store.nurseries.find((nr) => nr.workspace_id === l.nursery_workspace_id);
                  return {
                    ...l,
                    nursery_name: n?.nursery_name ?? 'Vườn Sa Đéc',
                    hamlet_area: n?.hamlet_area ?? 'Tân Quy Đông',
                  };
                });
                return { results: lotsWithNursery as T[] };
              }
              if (/FROM b2b_bookings b/i.test(query)) {
                const res = store.bookings.map((b) => ({
                  ...b,
                  lot_name: 'Cúc Mâm Xôi',
                  lot_code: 'SDEC-LOT-1001',
                  nursery_name: 'Vườn Kiểng Út Thắng',
                }));
                return { results: res as T[] };
              }
              if (/FROM escrow_ledger_entries/i.test(query)) {
                const bookingId = params[0];
                const res = store.ledger.filter((led) => led.booking_id === bookingId);
                return { results: res as T[] };
              }
              if (/FROM hub_dispatch_trips/i.test(query)) {
                return { results: store.trips as T[] };
              }
              if (/FROM shipment_packages p/i.test(query)) {
                const tripId = params[0];
                const res = store.packages.filter((p) => p.trip_id === tripId);
                return { results: res as T[] };
              }
              return { results: [] };
            },
            async run() {
              if (/INSERT INTO supply_lots/i.test(query)) {
                store.lots.push({
                  id: params[0],
                  lot_code: params[1],
                  nursery_workspace_id: params[2],
                  name: params[3],
                  mode: params[4],
                  species: params[5],
                  grade: params[6],
                  pot_diameter_cm: params[7],
                  height_cm: params[8],
                  canopy_cm: params[9],
                  bud_specification: params[10],
                  media_proof_url: params[11],
                  unit: params[12],
                  unit_price_vnd: params[13],
                  deposit_rate_bps: params[14],
                  moq_units: params[15],
                  total_units: params[16],
                  available_units: params[17],
                  cut_or_ship_date: params[18],
                  qr_lot_token: params[19],
                  status: 'PUBLISHED',
                });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (/FROM hub_dispatch_trips/i.test(query)) {
            return { results: store.trips as T[] };
          }
          if (/FROM supply_lots/i.test(query)) {
            return { results: store.lots as T[] };
          }
          return { results: [] };
        },
        async first<T>(): Promise<T | null> {
          if (/COUNT\(\*\) AS total FROM nursery_profiles/i.test(query)) {
            return { total: store.nurseries.length } as T;
          }
          if (/COUNT\(DISTINCT buyer_workspace_id\) AS total FROM b2b_bookings/i.test(query)) {
            return { total: 1 } as T;
          }
          if (/COUNT\(\*\) AS total FROM b2b_bookings WHERE status IN/i.test(query)) {
            return { total: 0 } as T;
          }
          if (/SELECT COUNT\(\*\) AS total FROM \(.*GROUP BY buyer_workspace_id/i.test(query)) {
            return { total: 0 } as T;
          }
          return null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      } as unknown as ReturnType<D1Like['prepare']>;
    },
    async batch(statements) {
      for (const stmt of statements) {
        const bound = (stmt as { bound?: unknown[] }).bound ?? [];
        // execute operations
      }
      return [];
    },
  };

  return { db, store };
}

describe('B2B API Routes and Security Chokepoint', () => {
  let fakeD1: { db: D1Like; store: FakeD1Store };

  const memberStore: MembershipStore = {
    async findBySubject(sub, ws) {
      if (sub === 'sub-founder' && ws === 'ws-demo-a') {
        return { identityId: 'id-founder', role: 'founder_admin', revokedAt: null };
      }
      if (sub === 'sub-nursery' && ws === 'ws-demo-a') {
        return { identityId: 'id-nursery', role: 'workspace_owner', revokedAt: null };
      }
      if (sub === 'sub-shop' && ws === 'ws-shop-a') {
        return { identityId: 'id-shop', role: 'workspace_owner', revokedAt: null };
      }
      return null;
    },
    async listBySubject(sub) {
      if (sub === 'sub-founder') return [{ workspaceId: 'ws-demo-a', role: 'founder_admin' }];
      if (sub === 'sub-nursery') return [{ workspaceId: 'ws-demo-a', role: 'workspace_owner' }];
      if (sub === 'sub-shop') return [{ workspaceId: 'ws-shop-a', role: 'workspace_owner' }];
      return [];
    },
  };

  beforeEach(() => {
    fakeD1 = createInMemoryD1();
    setMembershipStore(memberStore);
    setVerifier(async (header) => {
      if (header === 'token-founder') return { accessSubject: 'sub-founder', email: 'founder@sadec.test' };
      if (header === 'token-nursery') return { accessSubject: 'sub-nursery', email: 'nursery@sadec.test' };
      if (header === 'token-shop') return { accessSubject: 'sub-shop', email: 'shop@hcm.test' };
      return null;
    });
  });

  afterEach(() => {
    setMembershipStore(null);
    setVerifier(null);
  });

  function makeRequest(
    path: string,
    options: {
      method?: string;
      token?: string;
      workspaceId?: string;
      secFetchSite?: string;
      body?: unknown;
    } = {},
  ): Request {
    const url = new URL(path, ORIGIN);
    if (options.workspaceId) url.searchParams.set('workspace_id', options.workspaceId);

    const headers: Record<string, string> = {
      'Sec-Fetch-Site': options.secFetchSite ?? 'same-origin',
    };
    if (options.token) headers['Cf-Access-Jwt-Assertion'] = options.token;
    if (options.body) headers['content-type'] = 'application/json';

    return new Request(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }

  it('GET /api/b2b/lots allows reading published supply lots', async () => {
    const req = makeRequest('/api/b2b/lots', {
      token: 'token-shop',
      workspaceId: 'ws-shop-a',
    });
    const res = await worker.fetch(req, { APP_ENV: 'pilot', sadec_pilot: fakeD1.db }, CTX);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { lots: unknown[] };
    expect(data.lots).toHaveLength(1);
  });

  it('POST /api/b2b/lots/create allows nursery owner to publish new lot', async () => {
    const req = makeRequest('/api/b2b/lots/create', {
      method: 'POST',
      token: 'token-nursery',
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
    });

    const res = await worker.fetch(req, { APP_ENV: 'pilot', sadec_pilot: fakeD1.db }, CTX);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { lot: { name: string; qr_lot_token: string } };
    expect(data.lot.name).toBe('Mai Vàng Sa Đéc 5 Cánh');
    expect(data.lot.qr_lot_token.startsWith('SDECQR.')).toBe(true);
  });

  it('POST /api/b2b/lots/create blocks cross-site mutation via Sec-Fetch-Site', async () => {
    const req = makeRequest('/api/b2b/lots/create', {
      method: 'POST',
      token: 'token-nursery',
      workspaceId: 'ws-demo-a',
      secFetchSite: 'cross-site',
      body: {
        name: 'Xâm Nhập Cross Site',
        mode: 'WEEKLY_CATALOG',
      },
    });

    const res = await worker.fetch(req, { APP_ENV: 'pilot', sadec_pilot: fakeD1.db }, CTX);
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/nguồn gửi không khớp/i);
  });

  it('POST /api/b2b/bookings/confirm-deposit only permits founder_admin', async () => {
    // Nursery operator/owner tries to confirm deposit -> Forbidden (wrong role)
    const reqDenied = makeRequest('/api/b2b/bookings/confirm-deposit', {
      method: 'POST',
      token: 'token-nursery',
      workspaceId: 'ws-demo-a',
      body: { booking_id: 'bk-01' },
    });
    const resDenied = await worker.fetch(reqDenied, { APP_ENV: 'pilot', sadec_pilot: fakeD1.db }, CTX);
    expect(resDenied.status).toBe(403);

    // Founder confirms deposit -> Authorized
    const reqAllowed = makeRequest('/api/b2b/bookings/confirm-deposit', {
      method: 'POST',
      token: 'token-founder',
      workspaceId: 'ws-demo-a',
      body: { booking_id: 'bk-01' },
    });
    const resAllowed = await worker.fetch(reqAllowed, { APP_ENV: 'pilot', sadec_pilot: fakeD1.db }, CTX);
    expect(resAllowed.status).toBe(200);
  });

  it('GET /api/b2b/pilot-dashboard returns KPI metrics to founder_admin', async () => {
    const req = makeRequest('/api/b2b/pilot-dashboard', {
      token: 'token-founder',
      workspaceId: 'ws-demo-a',
    });
    const res = await worker.fetch(req, { APP_ENV: 'pilot', sadec_pilot: fakeD1.db }, CTX);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      metrics: { isNurseryGoalMet: boolean; isLedgerBalanced: boolean; totalPlatformOutlayVnd: number };
    };
    expect(data.metrics.isLedgerBalanced).toBe(true);
    expect(data.metrics.totalPlatformOutlayVnd).toBe(0);
  });
});
