/**
 * The public machine-readable surface, generated from the database.
 *
 * What this file proves, and why each assertion is the one worth having:
 *
 * 1. **The documents are generated, not stored.** The `revision` string for a
 *    lot is `${id}:u${available_units}:${status}:${updated_at}`. Changing
 *    availability in the database changes the document on the next request —
 *    which a committed file could not do, and which is the whole point of
 *    replacing `public/llms-full.txt` with a route.
 * 2. **Only published lots are described.** A DRAFT lot is not inventory and
 *    must not be quotable by an agent.
 * 3. **No private field reaches the text.** Owner names, phone numbers, QR
 *    tokens and workspace ids stay in the database. A test inserts distinctive
 *    values into the private tables and asserts none of them appear in any
 *    public document — the JSON API and the prose are checked the same way.
 * 4. **A hostile lot name cannot escape into the HTML.** `/discover` embeds lot
 *    text; it must be escaped, because the name comes from a tenant's form.
 */
import { describe, expect, it } from 'vitest';
import { handlePublicDocument, PUBLIC_DOCUMENT_PATHS } from '../src/ops/public-documents.ts';
import { handlePublicCatalog } from '../src/ops/public-discovery-routes.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';

const ORIGIN = 'https://demo.example.test';

async function render(pathname: (typeof PUBLIC_DOCUMENT_PATHS)[number], db: ReturnType<typeof createSqliteD1>['db']) {
  const response = await handlePublicDocument(db, pathname, ORIGIN);
  expect(response.status).toBe(200);
  return { response, body: await response.text() };
}

describe('public documents are generated from the database', () => {
  it('llms-full.txt carries the live revision of each published lot, and changes when inventory does', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const first = await render('/llms-full.txt', db);
    expect(first.response.headers.get('content-type')).toContain('text/plain');

    const row = raw
      .prepare(`SELECT id, available_units, status, updated_at FROM supply_lots WHERE status = 'PUBLISHED' LIMIT 1`)
      .get() as { id: string; available_units: number; status: string; updated_at: string };
    const revision = `${row.id}:u${row.available_units}:${row.status}:${row.updated_at}`;
    expect(first.body).toContain(revision);
    expect(first.body).toContain(`Số lượng còn lại: ${row.available_units} `);

    // A booking (or any write) that lowers availability must show up next read.
    raw
      .prepare(`UPDATE supply_lots SET available_units = available_units - 7, updated_at = '2026-10-30T01:02:03.000Z' WHERE id = ?`)
      .run(row.id);
    const second = await render('/llms-full.txt', db);
    expect(second.body).not.toContain(revision);
    expect(second.body).toContain(`${row.id}:u${row.available_units - 7}:${row.status}:2026-10-30T01:02:03.000Z`);
  });

  it('never describes a lot that is not published', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    raw
      .prepare(`UPDATE supply_lots SET status = 'DRAFT', name = 'Lô nháp bí mật' WHERE id = (SELECT id FROM supply_lots LIMIT 1)`)
      .run();
    const { body } = await render('/llms-full.txt', db);
    expect(body).not.toContain('Lô nháp bí mật');
    const discover = await render('/discover', db);
    expect(discover.body).not.toContain('Lô nháp bí mật');
    const catalog = await handlePublicCatalog(db, ORIGIN);
    expect(await catalog.text()).not.toContain('Lô nháp bí mật');
  });

  it('leaks no owner name, phone number, QR token or workspace id', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    // Distinctive private values, written where they belong.
    raw
      .prepare(`UPDATE workspaces SET name = 'PRIVATE-OWNER-NAME' WHERE id = 'ws-demo-b'`)
      .run();
    raw
      .prepare(`UPDATE nursery_profiles SET phone = 'PRIVATE-PHONE-0909' WHERE workspace_id = 'ws-demo-b'`)
      .run();
    raw
      .prepare(`UPDATE supply_lots SET qr_lot_token = 'PRIVATE-QR-TOKEN' WHERE nursery_workspace_id = 'ws-demo-b'`)
      .run();

    for (const pathname of PUBLIC_DOCUMENT_PATHS) {
      const { body } = await render(pathname, db);
      expect(body, pathname).not.toContain('PRIVATE-OWNER-NAME');
      expect(body, pathname).not.toContain('PRIVATE-PHONE-0909');
      expect(body, pathname).not.toContain('PRIVATE-QR-TOKEN');
      expect(body, pathname).not.toContain('ws-demo-b');
    }
    const catalog = await handlePublicCatalog(db, ORIGIN);
    const catalogBody = await catalog.text();
    expect(catalogBody).not.toContain('PRIVATE-OWNER-NAME');
    expect(catalogBody).not.toContain('PRIVATE-PHONE-0909');
    expect(catalogBody).not.toContain('PRIVATE-QR-TOKEN');
  });

  it('escapes a lot name that tries to inject markup into /discover', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    raw
      .prepare(`UPDATE supply_lots SET name = '<script>alert(1)</script>' WHERE status = 'PUBLISHED'`)
      .run();
    const { response, body } = await render('/discover', db);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('answers every path with its own type, and an empty catalog honestly', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const types = new Map<string, string>();
    for (const pathname of PUBLIC_DOCUMENT_PATHS) {
      const { response } = await render(pathname, db);
      types.set(pathname, response.headers.get('content-type') ?? '');
    }
    expect(types.get('/llms.txt')).toContain('text/plain');
    expect(types.get('/docs.md')).toContain('text/markdown');
    expect(types.get('/robots.txt')).toContain('text/plain');
    expect(types.get('/sitemap.xml')).toContain('application/xml');
    expect(types.get('/discover')).toContain('text/html');

    // No database is *unavailable*, not "nothing published" — the distinction
    // that keeps an agent from reporting a sold-out nursery it never looked at.
    const unbound = await handlePublicDocument(null, '/llms-full.txt', ORIGIN);
    expect(unbound.status).toBe(503);
    expect(await unbound.text()).toContain('không truy cập được');
  });

  it('points its links at the origin that served the request', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const { body } = await render('/llms.txt', db);
    expect(body).toContain(`${ORIGIN}/api/public/catalog`);
    expect(body).not.toContain('sadec-flow.example.com');
  });
});

/**
 * A failed read is answered as a failure, not as an empty catalogue.
 *
 * An earlier revision answered `200` with an empty list and `no-store`. The
 * status was still the problem: `200` is the same status an empty catalogue
 * carries, so a client that only looks at the status (or a crawler that only
 * keeps the body) reads "sold out". The full matrix lives in
 * `test/public-catalog-availability.test.ts`; these two cases keep the
 * document-level wording pinned here, next to the documents themselves.
 */
describe('a failed read is answered as unavailable', () => {
  const failingDb = {
    prepare() {
      throw new Error('D1_ERROR: no such table: supply_lots');
    },
    async batch() {
      throw new Error('D1_ERROR: no such table: supply_lots');
    },
  } as unknown as ReturnType<typeof createSqliteD1>['db'];

  it('serves a 503 with no-store and leaks no error text', async () => {
    const response = await handlePublicCatalog(failingDb, ORIGIN);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toContain('D1_ERROR');
    expect(body).not.toContain('supply_lots');
    expect((JSON.parse(body) as { code?: string }).code).toBe('catalog_unavailable');
  });

  it('serves the reader documents as 503 too, in prose that does not claim empty stock', async () => {
    for (const pathname of ['/llms-full.txt', '/discover'] as const) {
      const response = await handlePublicDocument(failingDb, pathname, ORIGIN);
      expect(response.status, pathname).toBe(503);
      expect(response.headers.get('cache-control'), pathname).toBe('no-store');
      const body = await response.text();
      expect(body, pathname).not.toContain('D1_ERROR');
      expect(body, pathname).not.toContain('chưa có lô hoa nào được niêm yết');
    }
  });

  it('keeps the short cache on a healthy read', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const healthy = await handlePublicCatalog(db, ORIGIN);
    expect(healthy.status).toBe(200);
    expect(healthy.headers.get('cache-control')).toBe('public, max-age=60');
  });
});
