/**
 * The public catalogue: "nothing is published" and "nobody could look" are
 * different answers, and the difference has to survive the wire.
 *
 * An agent or a crawler that reads a failed read as an empty catalogue tells a
 * buyer the nursery is out of stock. The failure this file pins is therefore not
 * an exception escaping — it is a plausible-looking success. The contract now:
 *
 *   - read succeeded, nothing published → `200`, `lots: []`, cacheable;
 *   - read succeeded, lots present      → `200`, unchanged shape, cacheable;
 *   - query failed                      → `503`, `catalog_unavailable`, no-store;
 *   - no D1 binding in an environment that serves the catalogue → `503` too;
 *   - recovery                          → the next request is a `200` again.
 *
 * Every failure case also asserts what must *not* appear: no SQL, no table or
 * binding name, no stack frame, and no invented lot.
 */
import { describe, expect, it } from 'vitest';
import {
  handlePublicCatalog,
  handlePublicDiscover,
  readPublishedLots,
} from '../src/ops/public-discovery-routes.ts';
import { handlePublicDocument } from '../src/ops/public-documents.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';
import type { D1Like } from '../src/ops/catalog.ts';

const ORIGIN = 'https://demo.example.test';

/** A binding that exists and whose every query fails, like a missing schema. */
const failingDb = {
  prepare() {
    throw new Error('D1_ERROR: no such table: supply_lots');
  },
  async batch() {
    throw new Error('D1_ERROR: no such table: supply_lots');
  },
} as unknown as D1Like;

/** What a leaked internal detail would look like if one escaped. */
const FORBIDDEN_FRAGMENTS = [
  'D1_ERROR',
  'supply_lots',
  'SELECT',
  'sqlite',
  'sadec_demo',
  'sadec_pilot',
  'nursery_profiles',
  'at Object.',
  '\n    at ',
];

function expectNoInternals(body: string): void {
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    expect(body, `leaked ${fragment}`).not.toContain(fragment);
  }
}

describe('a published catalogue is a 200 whatever its size', () => {
  it('serves lots, unchanged shape, cacheable for a minute', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const response = await handlePublicCatalog(db, ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await response.json()) as { origin: string; lots: unknown[] };
    expect(body.origin).toBe(ORIGIN);
    expect(body.lots.length).toBeGreaterThan(0);
    // The public projection never carries a tenant id.
    expect(JSON.stringify(body)).not.toContain('nursery_workspace_id');
  });

  it('serves an empty catalogue as a 200 when nothing is published', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    raw.exec("UPDATE supply_lots SET status = 'DRAFT'");
    const response = await handlePublicCatalog(db, ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(((await response.json()) as { lots: unknown[] }).lots).toEqual([]);

    // The documents say "not published yet", which is true, and not "unavailable".
    const doc = await handlePublicDocument(db, '/llms-full.txt', ORIGIN);
    expect(doc.status).toBe(200);
    const text = await doc.text();
    expect(text).toContain('chưa có lô hoa nào được niêm yết');
    expect(text).not.toContain('không truy cập được');
  });
});

describe('an unreadable catalogue is a 503, never an empty one', () => {
  it('answers the JSON API with a Vietnamese error and a stable code', async () => {
    const response = await handlePublicCatalog(failingDb, ORIGIN);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('60');

    const body = await response.text();
    const parsed = JSON.parse(body) as { error?: string; code?: string; lots?: unknown };
    expect(parsed.code).toBe('catalog_unavailable');
    expect(parsed.error).toMatch(/không truy cập được/i);
    // Not a lot list at all: a caller cannot mistake this for "none published".
    expect(parsed.lots).toBeUndefined();
    expectNoInternals(body);
  });

  it('answers /api/discover with a page that does not claim the shelves are empty', async () => {
    const response = await handlePublicDiscover(failingDb, ORIGIN);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('data-catalog-status="unavailable"');
    expect(html).toContain('không truy cập được');
    expect(html).not.toContain('chưa có lô hoa nào được niêm yết');
    expect(html).not.toContain('Hết hàng');
    expectNoInternals(html);
  });

  it('answers the text and HTML documents the same way', async () => {
    for (const pathname of ['/llms-full.txt', '/discover'] as const) {
      const response = await handlePublicDocument(failingDb, pathname, ORIGIN);
      expect(response.status, pathname).toBe(503);
      expect(response.headers.get('cache-control'), pathname).toBe('no-store');
      const body = await response.text();
      expect(body, pathname).toContain('không truy cập được');
      expect(body, pathname).not.toContain('chưa có lô hoa nào được niêm yết');
      expectNoInternals(body);
    }
  });

  it('keeps the documents that read no data at all as 200', async () => {
    // `/llms.txt`, `/docs.md`, `/robots.txt` and `/sitemap.xml` describe the
    // service, not its inventory. A database failure has nothing to say about
    // them, and turning them into 503 would hide the API from a crawler for a
    // reason that does not apply.
    for (const pathname of ['/llms.txt', '/docs.md', '/robots.txt', '/sitemap.xml'] as const) {
      const response = await handlePublicDocument(failingDb, pathname, ORIGIN);
      expect(response.status, pathname).toBe(200);
    }
  });

  it('treats a missing binding as unavailable, not as an empty catalogue', async () => {
    const read = await readPublishedLots(null);
    expect(read).toEqual({ ok: false, reason: 'no_database' });

    const catalog = await handlePublicCatalog(null, ORIGIN);
    expect(catalog.status).toBe(503);
    expect(((await catalog.json()) as { code?: string }).code).toBe('catalog_unavailable');

    for (const pathname of ['/llms-full.txt', '/discover'] as const) {
      const response = await handlePublicDocument(null, pathname, ORIGIN);
      expect(response.status, pathname).toBe(503);
      expect(response.headers.get('cache-control'), pathname).toBe('no-store');
    }
  });

  it('recovers: the same handler answers 200 once the database works again', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    // Break it, then repair it, and drive the same request twice.
    raw.exec('ALTER TABLE supply_lots RENAME TO supply_lots_broken');

    const broken = await handlePublicCatalog(db, ORIGIN);
    expect(broken.status).toBe(503);

    raw.exec('ALTER TABLE supply_lots_broken RENAME TO supply_lots');
    const healed = await handlePublicCatalog(db, ORIGIN);
    expect(healed.status).toBe(200);
    expect(((await healed.json()) as { lots: unknown[] }).lots.length).toBeGreaterThan(0);

    const healedDoc = await handlePublicDocument(db, '/llms-full.txt', ORIGIN);
    expect(healedDoc.status).toBe(200);
  });

  it('never fabricates a lot to fill an unreadable catalogue', async () => {
    for (const db of [failingDb, null]) {
      const response = await handlePublicCatalog(db, ORIGIN);
      const body = await response.text();
      // No seeded id, no revision of the seeded lots, no quote object.
      for (const marker of ['lot-w-01', 'lot-tet-01', 'sample_moq_quote', 'SDEC-LOT-']) {
        expect(body, marker).not.toContain(marker);
      }
    }
  });
});
