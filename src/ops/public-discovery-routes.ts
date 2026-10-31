/**
 * Public discovery routes for AEO/GEO crawlers and WebMCP agents.
 *
 * These endpoints are declared `kind: 'public'` in the Worker registry: they are
 * read-only, take no `workspace_id`, never call a second authorization path, and
 * project all lot data through `toPublicLotProjection` so zero PII (`owner_name`,
 * `phone`, `buyer_contact_phone`, `tax_code`) ever leaves the edge.
 *
 * Unavailable is not empty.
 *
 * These handlers used to answer a failed read with `200` and an empty list,
 * which reads exactly like "no lots are published" — to a crawler, to an agent,
 * and to a person. The two are now separated: a successful read with nothing
 * published is `200` with `lots: []`, and a read that could not reach the data
 * is `503` with `code: "catalog_unavailable"` and `cache-control: no-store`. A
 * missing D1 binding counts as unavailable in an environment that is supposed to
 * serve the catalogue; it is not a quietly empty catalogue.
 *
 * No error detail crosses the boundary: the message is one Vietnamese sentence,
 * and no SQL text, table name, binding name or stack frame is included.
 */

import type { D1Like } from './catalog.ts';
import { apiError } from './api-error.ts';
import type { SupplyLotRow } from './b2b-catalog.ts';
import {
  CATALOG_UNAVAILABLE_MESSAGE,
  toPublicLotProjection,
  renderCatalogUnavailableHtml,
  renderDiscoverHtml,
  buildAgentJsonSchemas,
  type PublicLotProjection,
} from '../domain/aeo-projection.ts';

type PublicLotJoinRow = SupplyLotRow & {
  nursery_name?: string;
  hamlet_area?: string;
  fulfillment_score_bps?: number;
};

const PUBLIC_CACHE_CONTROL = 'public, max-age=60';

/**
 * The cache policy for one answer.
 *
 * A successful read is cacheable for a minute. A read that *failed* is not
 * cacheable at all: the answer is still a 200 with an empty list (an agent
 * should not be handed a stack trace), but "no lots" produced by a database
 * error is a statement about the moment, not about the catalogue. Caching it
 * for a minute would turn a transient failure into a crawled fact — and the
 * documents promise the opposite, that nothing is invented when the read fails.
 */
function cacheControlFor(degraded: boolean): string {
  return degraded ? 'no-store' : PUBLIC_CACHE_CONTROL;
}

/**
 * The published lots, and whether the read actually reached the database.
 *
 * `degraded` is false when there is no database at all (a deployment that has
 * not been given its binding is honestly empty) and true when a binding exists
 * and the query failed. Callers use it to decide whether the answer may be
 * cached; they do not use it to change what is shown.
 */
/**
 * The catalogue, or the reason it could not be read.
 *
 * `ok: false` is a statement about *this request*, never about the market: the
 * caller must not turn it into an empty list. `no_database` is the binding being
 * absent (a deployment that should serve the catalogue and cannot), `query_failed`
 * is a query that threw (a missing schema, a connection that went away).
 */
export type CatalogRead =
  | { ok: true; lots: PublicLotProjection[] }
  | { ok: false; reason: 'no_database' | 'query_failed' };

export async function readPublishedLots(
  db: D1Like | null,
  modeFilter?: 'WEEKLY_CATALOG' | 'SEASONAL_PREORDER' | null,
): Promise<CatalogRead> {
  if (db === null) {
    return { ok: false, reason: 'no_database' };
  }

  try {
    const query = `
      SELECT l.*, n.nursery_name, n.hamlet_area, n.fulfillment_score_bps
        FROM supply_lots l
        JOIN nursery_profiles n ON n.workspace_id = l.nursery_workspace_id
       WHERE l.status = ?
       ORDER BY l.cut_or_ship_date ASC, l.name ASC
       LIMIT 100
    `;
    const { results } = await db
      .prepare(query)
      .bind('PUBLISHED')
      .all<PublicLotJoinRow>();

    return {
      ok: true,
      lots: results
        .filter(
          (row) =>
            row.status === 'PUBLISHED' &&
            (!modeFilter || row.mode === modeFilter),
        )
        .slice(0, 100)
        .map((row) => toPublicLotProjection(row)),
    };
  } catch {
    // Swallowed on purpose: the reason is reported as `query_failed`, and the
    // error text (which may name a table) is never returned to a caller.
    return { ok: false, reason: 'query_failed' };
  }
}

/**
 * The 503 for a catalogue that could not be read.
 *
 * `no-store` because this is a statement about the moment: caching it would turn
 * a transient failure into a crawled fact. `retry-after` because the honest
 * instruction to a crawler is to come back, not to conclude.
 */
function catalogUnavailable(): Response {
  const response = apiError(CATALOG_UNAVAILABLE_MESSAGE, 503, 'catalog_unavailable');
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('retry-after', '60');
  return new Response(response.body, { status: response.status, headers });
}

export async function handlePublicCatalog(
  db: D1Like | null,
  origin = '',
  searchParams?: URLSearchParams,
): Promise<Response> {
  const rawMode = searchParams?.get('mode');
  const modeFilter =
    rawMode === 'WEEKLY_CATALOG' || rawMode === 'SEASONAL_PREORDER'
      ? rawMode
      : null;

  const read = await readPublishedLots(db, modeFilter);
  if (!read.ok) return catalogUnavailable();

  // The success shape is unchanged: `{ origin, lots }`, cacheable for a minute.
  return new Response(JSON.stringify({ origin, lots: read.lots }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': PUBLIC_CACHE_CONTROL,
    },
  });
}

export function handlePublicSchema(): Response {
  const schemas = buildAgentJsonSchemas();
  return new Response(JSON.stringify(schemas), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': PUBLIC_CACHE_CONTROL,
    },
  });
}

export async function handlePublicDiscover(
  db: D1Like | null,
  origin = '',
): Promise<Response> {
  const read = await readPublishedLots(db);
  if (!read.ok) {
    return new Response(renderCatalogUnavailableHtml(origin), {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '60',
      },
    });
  }

  const html = renderDiscoverHtml(read.lots, origin);
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': PUBLIC_CACHE_CONTROL,
    },
  });
}
