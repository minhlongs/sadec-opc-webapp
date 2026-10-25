import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { setMembershipStore, setVerifier } from '../src/worker/index.ts';
import type { MembershipStore } from '../src/security/authorize.ts';
import type { D1Like, D1Statement } from '../src/ops/catalog.ts';

/**
 * Hợp đồng khám phá AEO/GEO của Worker: các route công khai không cần danh tính,
 * không lộ PII, không phụ thuộc DB, và `expected_revision` chặn đặt giữ trên dữ
 * liệu tồn kho đã cũ mà không làm đổi `available_units`.
 */

const ORIGIN = 'https://pilot.example.test';
const CTX: { access?: unknown } = {};
const ACCESS_AUD_VALUE = 'aud-should-never-leak-9f3a';

type Row = Record<string, unknown>;

interface FakeStore {
  lots: Row[];
  nurseries: Row[];
  bookings: Row[];
}

interface BoundStatement extends D1Statement {
  query: string;
  params: unknown[];
}

/**
 * Một D1 in-memory có trạng thái. Khác bản fake trong `b2b-routes.test.ts`,
 * `batch` ở đây thực sự trừ tồn kho và ghi đơn, vì test `expected_revision` phải
 * đo được `available_units` trước và sau.
 */
function createStatefulD1(): { db: D1Like; store: FakeStore } {
  const store: FakeStore = {
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
        fulfillment_score_bps: 9500,
        created_at: '2026-10-25T08:00:00.000Z',
        updated_at: '2026-10-25T08:00:00.000Z',
      },
    ],
    bookings: [
      {
        id: 'bk-seed',
        booking_code: 'SDEC-BK-SEED',
        lot_id: 'lot-01',
        nursery_workspace_id: 'ws-demo-a',
        buyer_workspace_id: 'ws-shop-a',
        buyer_shop_name: 'Tiệm Hoa Sài Gòn Phố',
        buyer_contact_phone: '0903123456',
        quantity: 50,
        status: 'BOOKED_PENDING_DEPOSIT',
      },
    ],
  };

  const lotWithNursery = (lot: Row): Row => {
    const nursery = store.nurseries.find((n) => n.workspace_id === lot.nursery_workspace_id);
    return {
      ...lot,
      nursery_name: nursery?.nursery_name ?? null,
      hamlet_area: nursery?.hamlet_area ?? null,
      fulfillment_score_bps: nursery?.fulfillment_score_bps ?? null,
      owner_name: nursery?.owner_name ?? null,
      phone: nursery?.phone ?? null,
    };
  };

  const bind = (query: string, params: unknown[]): BoundStatement => ({
    query,
    params,
    async first<T>(): Promise<T | null> {
      if (/FROM b2b_bookings/i.test(query)) {
        return (store.bookings.find((b) => b.id === params[0]) as T | undefined) ?? null;
      }
      if (/FROM supply_lots/i.test(query)) {
        const lot = store.lots.find((l) => l.id === params[0]);
        return lot ? (lotWithNursery(lot) as T) : null;
      }
      return null;
    },
    async all<T>(): Promise<{ results: T[] }> {
      if (/FROM supply_lots/i.test(query)) {
        return { results: store.lots.map(lotWithNursery) as T[] };
      }
      if (/FROM b2b_bookings/i.test(query)) {
        return { results: store.bookings as T[] };
      }
      return { results: [] };
    },
    async run() {
      return { meta: { changes: 0 } };
    },
  });

  const db: D1Like = {
    prepare(query: string) {
      return {
        ...bind(query, []),
        bind: (...params: unknown[]) => bind(query, params),
      };
    },
    async batch<T>(statements: T[]) {
      for (const statement of statements) {
        const { query, params } = statement as unknown as BoundStatement;
        if (/UPDATE supply_lots/i.test(query)) {
          const [quantity, , , lotId] = params as [number, number, string, string, number];
          const lot = store.lots.find((l) => l.id === lotId);
          if (lot && Number(lot.available_units) >= quantity) {
            lot.available_units = Number(lot.available_units) - quantity;
            if (lot.available_units === 0) lot.status = 'SOLD_OUT';
          }
        } else if (/INSERT INTO b2b_bookings/i.test(query)) {
          store.bookings.push({
            id: params[0],
            booking_code: params[1],
            lot_id: params[2],
            nursery_workspace_id: params[3],
            buyer_workspace_id: params[4],
            buyer_shop_name: params[5],
            buyer_contact_phone: params[6],
            destination_market: params[7],
            quantity: params[8],
            unit_price_vnd: params[9],
            gross_total_vnd: params[10],
            deposit_rate_bps: params[11],
            deposit_required_vnd: params[12],
            deposit_paid_vnd: 0,
            platform_fee_bps: 300,
            platform_fee_vnd: params[13],
            status: 'BOOKED_PENDING_DEPOSIT',
            note: params[14],
          });
        }
      }
      return [];
    },
  };

  return { db, store };
}

const shopStore: MembershipStore = {
  async findBySubject(subject, workspaceId) {
    if (subject === 'sub-shop' && workspaceId === 'ws-shop-a') {
      return { identityId: 'id-shop', role: 'workspace_owner', revokedAt: null };
    }
    return null;
  },
  async listBySubject(subject) {
    return subject === 'sub-shop' ? [{ workspaceId: 'ws-shop-a', role: 'workspace_owner' }] : [];
  },
};

function publicRequest(path: string): Request {
  return new Request(new URL(path, ORIGIN), { method: 'GET' });
}

function envWith(db: D1Like): Record<string, unknown> {
  return { APP_ENV: 'pilot', ACCESS_AUD: ACCESS_AUD_VALUE, sadec_pilot: db };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Cần một object, nhận được: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** Bỏ chú thích `//`, `/* *​/` và dấu phẩy thừa của JSONC, giữ nguyên nội dung chuỗi. */
function stripJsonc(source: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

describe('cấu hình wrangler giữ ranh giới API', () => {
  it('wrangler.jsonc parse được và chỉ gửi /api/* vào Worker trước', () => {
    const raw = readFileSync(join(process.cwd(), 'wrangler.jsonc'), 'utf8');
    const config = asRecord(JSON.parse(stripJsonc(raw)));
    const assets = asRecord(config.assets);
    expect(assets.run_worker_first).toEqual(['/api/*']);
    expect(config.run_worker_first).toBeUndefined();
  });
});

describe('route khám phá công khai', () => {
  let fake: ReturnType<typeof createStatefulD1>;

  beforeEach(() => {
    fake = createStatefulD1();
    // Không có verifier và không có membership: route công khai phải tự đứng được.
    setVerifier(null);
    setMembershipStore(null);
  });

  afterEach(() => {
    setVerifier(null);
    setMembershipStore(null);
  });

  it('GET /api/public/catalog trả 200 JSON mà không cần token và hỗ trợ lọc mode', async () => {
    const res = await worker.fetch(publicRequest('/api/public/catalog'), envWith(fake.db), CTX);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = asRecord(await res.json());
    expect(body.origin).toBe(ORIGIN);
    expect(Array.isArray(body.lots)).toBe(true);
    expect((body.lots as unknown[]).length).toBe(1);

    const seasonalRes = await worker.fetch(
      publicRequest('/api/public/catalog?mode=SEASONAL_PREORDER'),
      envWith(fake.db),
      CTX,
    );
    const seasonalBody = asRecord(await seasonalRes.json());
    expect((seasonalBody.lots as unknown[]).length).toBe(0);
  });

  it('GET /api/schema trả đủ 4 công cụ agent theo JSON Schema 2020-12', async () => {
    const res = await worker.fetch(publicRequest('/api/schema'), envWith(fake.db), CTX);
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const tools = ['listSupplyLots', 'quoteBooking', 'proposeBooking', 'verifyQrToken'];
    expect(Object.keys(body)).toEqual(expect.arrayContaining(tools));
    for (const tool of tools) {
      const schema = asRecord(body[tool]);
      const draft = String(schema.$schema ?? body.$schema ?? '');
      expect(draft, `${tool} thiếu $schema 2020-12`).toContain(
        'json-schema.org/draft/2020-12/schema',
      );
    }
  });

  it('GET /api/discover trả HTML tiếng Việt kèm JSON-LD WholesaleStore', async () => {
    const res = await worker.fetch(publicRequest('/api/discover'), envWith(fake.db), CTX);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<html lang="vi"');
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('WholesaleStore');
  });

  it('không lộ PII, token QR hay workspace nội bộ trong catalog công khai', async () => {
    const res = await worker.fetch(publicRequest('/api/public/catalog'), envWith(fake.db), CTX);
    expect(res.status).toBe(200);
    const payload = asRecord(await res.json());
    expect((payload.lots as unknown[]).length).toBeGreaterThan(0);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('SDEC-LOT-1001');
    const forbiddenKeys = [
      'owner_name',
      'buyer_contact_phone',
      'ACCESS_AUD',
      'qr_lot_token',
      'nursery_workspace_id',
    ];
    for (const key of forbiddenKeys) {
      expect(serialized, `rò khóa ${key}`).not.toContain(key);
    }
    // Cả giá trị thật cũng không được lọt qua dưới một tên khóa khác.
    const forbiddenValues = [
      'Nguyễn Văn Thắng',
      '0918123456',
      '0903123456',
      'SDECQR.demo.lot.01',
      'ws-demo-a',
      ACCESS_AUD_VALUE,
    ];
    for (const value of forbiddenValues) {
      expect(serialized, `rò giá trị ${value}`).not.toContain(value);
    }
  });

  it('vẫn trả 200 khi môi trường không có binding DB và không ném lỗi', async () => {
    const envs: Record<string, unknown>[] = [{ APP_ENV: 'pilot' }, {}];
    for (const env of envs) {
      for (const path of ['/api/public/catalog', '/api/schema', '/api/discover']) {
        const res = await worker.fetch(publicRequest(path), env, CTX);
        expect(res.status, `${path} với env ${JSON.stringify(env)}`).toBe(200);
      }
    }
  });
});

describe('expected_revision trên đặt giữ lô', () => {
  let fake: ReturnType<typeof createStatefulD1>;

  beforeEach(() => {
    fake = createStatefulD1();
    setMembershipStore(shopStore);
    setVerifier(async (header) =>
      header === 'token-shop' ? { accessSubject: 'sub-shop', email: 'shop@hcm.test' } : null,
    );
  });

  afterEach(() => {
    setVerifier(null);
    setMembershipStore(null);
  });

  function bookingRequest(extra: Record<string, unknown>): Request {
    const url = new URL('/api/b2b/bookings/create', ORIGIN);
    url.searchParams.set('workspace_id', 'ws-shop-a');
    return new Request(url, {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'same-origin',
        'content-type': 'application/json',
        'Cf-Access-Jwt-Assertion': 'token-shop',
      },
      body: JSON.stringify({
        lot_id: 'lot-01',
        quantity: 10,
        buyer_shop_name: 'Tiệm Hoa Sài Gòn Phố',
        buyer_contact_phone: '0903123456',
        destination_market: 'Chợ hoa Hồ Thị Kỷ, Quận 10',
        ...extra,
      }),
    });
  }

  async function currentRevision(): Promise<string> {
    const { computeLotRevision } = await import('../src/domain/aeo-projection.ts');
    const lot = fake.store.lots[0];
    if (!lot) throw new Error('Fake store không có lô nào.');
    return String(computeLotRevision(lot as never));
  }

  async function availableUnitsViaApi(): Promise<number> {
    const url = new URL('/api/b2b/lots', ORIGIN);
    url.searchParams.set('workspace_id', 'ws-shop-a');
    const res = await worker.fetch(
      new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': 'token-shop' } }),
      envWith(fake.db),
      CTX,
    );
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const lots = body.lots as Row[];
    const lot = lots.find((l) => l.id === 'lot-01');
    if (!lot) throw new Error('Không thấy lot-01 khi đọc lại qua API.');
    return Number(lot.available_units);
  }

  it('đặt giữ thành công 201 khi expected_revision khớp và tồn kho bị trừ đúng', async () => {
    const revision = await currentRevision();
    const res = await worker.fetch(
      bookingRequest({ expected_revision: revision }),
      envWith(fake.db),
      CTX,
    );
    expect(res.status).toBe(201);
    expect(await availableUnitsViaApi()).toBe(90);
  });

  it('từ chối 409 khi expected_revision sai và không đổi available_units', async () => {
    const before = await availableUnitsViaApi();
    const bookingsBefore = fake.store.bookings.length;
    const res = await worker.fetch(
      bookingRequest({ expected_revision: 'rev-da-cu-khong-khop' }),
      envWith(fake.db),
      CTX,
    );
    expect(res.status).toBe(409);
    expect(await availableUnitsViaApi()).toBe(before);
    expect(before).toBe(100);
    expect(fake.store.bookings).toHaveLength(bookingsBefore);
  });

  it('vẫn đặt giữ 201 khi không truyền expected_revision (tương thích ngược)', async () => {
    const res = await worker.fetch(bookingRequest({}), envWith(fake.db), CTX);
    expect(res.status).toBe(201);
    expect(await availableUnitsViaApi()).toBe(90);
  });
});
