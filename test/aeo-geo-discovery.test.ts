import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { setMembershipStore, setVerifier } from '../src/worker/index.ts';
import type { D1Like, D1Statement } from '../src/ops/catalog.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';

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
  it('wrangler.jsonc parse được, gửi /api/* và các tài liệu công khai vào Worker trước', () => {
    const raw = readFileSync(join(process.cwd(), 'wrangler.jsonc'), 'utf8');
    const config = asRecord(JSON.parse(stripJsonc(raw)));
    const assets = asRecord(config.assets);
    // The public documents are generated from D1 by the Worker, so the asset
    // router must not be allowed to answer them from a stale file.
    expect(assets.run_worker_first).toEqual([
      '/api/*',
      '/llms.txt',
      '/llms-full.txt',
      '/docs.md',
      '/robots.txt',
      '/sitemap.xml',
      '/discover',
      '/discover/',
    ]);
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

  it('trả 503 cho catalog và discover khi thiếu binding DB, không coi là danh mục rỗng', async () => {
    const envs: Record<string, unknown>[] = [{ APP_ENV: 'pilot' }, {}];
    for (const env of envs) {
      for (const path of ['/api/public/catalog', '/api/discover']) {
        const res = await worker.fetch(publicRequest(path), env, CTX);
        // A deployment that cannot read its catalogue says so; it does not
        // report "no lots are published", which would be a different claim.
        expect(res.status, `${path} với env ${JSON.stringify(env)}`).toBe(503);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
      // `/api/schema` describes the API rather than the inventory: no data, no
      // reason to fail with it.
      const schema = await worker.fetch(publicRequest('/api/schema'), env, CTX);
      expect(schema.status).toBe(200);
    }
  });
});

describe('expected_revision trên đặt giữ lô', () => {
  /**
   * Chạy trên SQLite thật qua các migration thật, không phải fake D1: điều cần
   * đo là `INSERT … SELECT` có điều kiện và lệnh trừ tồn kho trong cùng một
   * transaction thực sự không ghi gì khi revision sai. Lô `lot-w-02` (ws-demo-a,
   * 150 chậu, MOQ 15) được đặt bởi nhân viên demo trong `ws-shop-q1`.
   */
  const LOT_ID = 'lot-w-02';
  const BUYER_WS = 'ws-shop-q1';
  let harness: ReturnType<typeof createSqliteD1>;
  let env: Record<string, unknown>;

  beforeEach(() => {
    harness = createSqliteD1({ seedDemo: true });
    env = { APP_ENV: 'development', DEV_IDENTITY: 'demo-operator', DB: harness.db };
    setMembershipStore(null);
    setVerifier(null);
  });

  afterEach(() => {
    setVerifier(null);
    setMembershipStore(null);
  });

  function bookingRequest(extra: Record<string, unknown>): Request {
    const url = new URL('/api/b2b/bookings/create', ORIGIN);
    url.searchParams.set('workspace_id', BUYER_WS);
    return new Request(url, {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        lot_id: LOT_ID,
        quantity: 15,
        buyer_shop_name: 'Tiệm Hoa Sài Gòn Phố',
        buyer_contact_phone: '0903123456',
        destination_market: 'Chợ hoa Hồ Thị Kỷ, Quận 10',
        ...extra,
      }),
    });
  }

  function lotRow(): Row {
    const row = harness.raw.prepare('SELECT * FROM supply_lots WHERE id = ?').get(LOT_ID) as
      | Row
      | undefined;
    if (!row) throw new Error('Seed không có lô này.');
    return row;
  }

  function bookingCount(): number {
    const row = harness.raw
      .prepare('SELECT COUNT(*) AS total FROM b2b_bookings WHERE lot_id = ?')
      .get(LOT_ID) as { total: number };
    return Number(row.total);
  }

  async function currentRevision(): Promise<string> {
    const { computeLotRevision } = await import('../src/domain/aeo-projection.ts');
    return String(computeLotRevision(lotRow() as never));
  }

  async function availableUnitsViaApi(): Promise<number> {
    const url = new URL('/api/b2b/lots', ORIGIN);
    url.searchParams.set('workspace_id', BUYER_WS);
    const res = await worker.fetch(new Request(url), env, CTX);
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const lots = body.lots as Row[];
    const lot = lots.find((l) => l.id === LOT_ID);
    if (!lot) throw new Error(`Không thấy ${LOT_ID} khi đọc lại qua API.`);
    return Number(lot.available_units);
  }

  it('đặt giữ thành công 201 khi expected_revision khớp và tồn kho bị trừ đúng', async () => {
    const revision = await currentRevision();
    const res = await worker.fetch(bookingRequest({ expected_revision: revision }), env, CTX);
    expect(res.status).toBe(201);
    expect(await availableUnitsViaApi()).toBe(135);
    expect(bookingCount()).toBe(1);
  });

  it('từ chối 409 khi expected_revision sai và không đổi available_units', async () => {
    const before = await availableUnitsViaApi();
    const bookingsBefore = bookingCount();
    const res = await worker.fetch(
      bookingRequest({ expected_revision: `${LOT_ID}:u999:PUBLISHED:2020-01-01T00:00:00.000Z` }),
      env,
      CTX,
    );
    expect(res.status).toBe(409);
    const body = asRecord(await res.json());
    expect(body.code).toBe('revision_conflict');
    expect(await availableUnitsViaApi()).toBe(before);
    expect(before).toBe(150);
    expect(bookingCount()).toBe(bookingsBefore);
  });

  it('vẫn đặt giữ 201 khi không truyền expected_revision (tương thích ngược)', async () => {
    const res = await worker.fetch(bookingRequest({}), env, CTX);
    expect(res.status).toBe(201);
    expect(await availableUnitsViaApi()).toBe(135);
  });

  it('từ chối 409 insufficient_stock khi vượt tồn kho và không ghi gì', async () => {
    const res = await worker.fetch(bookingRequest({ quantity: 151 }), env, CTX);
    expect(res.status).toBe(409);
    const body = asRecord(await res.json());
    expect(body.code).toBe('insufficient_stock');
    expect(await availableUnitsViaApi()).toBe(150);
    expect(bookingCount()).toBe(0);
  });
});
