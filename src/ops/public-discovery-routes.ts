/**
 * Public discovery routes for AEO/GEO crawlers and WebMCP agents.
 *
 * These endpoints are declared `kind: 'public'` in the Worker registry: they are
 * read-only, take no `workspace_id`, never call a second authorization path, and
 * project all lot data through `toPublicLotProjection` so zero PII (`owner_name`,
 * `phone`, `buyer_contact_phone`, `tax_code`) ever leaves the edge.
 *
 * Every handler fails soft: when the environment has no D1 binding or a query
 * fails on an unmigrated database, the response is still `200 OK` with an empty
 * lot list rather than a 500 page.
 */

import type { D1Like } from './catalog.ts';
import type { SupplyLotRow } from './b2b-catalog.ts';
import {
  toPublicLotProjection,
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

async function loadPublishedLots(
  db: D1Like | null,
  modeFilter?: 'WEEKLY_CATALOG' | 'SEASONAL_PREORDER' | null,
): Promise<PublicLotProjection[]> {
  if (db === null) {
    return [];
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

    return results
      .filter(
        (row) =>
          row.status === 'PUBLISHED' &&
          (!modeFilter || row.mode === modeFilter),
      )
      .slice(0, 100)
      .map((row) => toPublicLotProjection(row));
  } catch {
    return [];
  }
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

  if (db === null) {
    return new Response(JSON.stringify({ origin, lots: [] }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': PUBLIC_CACHE_CONTROL,
      },
    });
  }

  const lots = await loadPublishedLots(db, modeFilter);
  return new Response(JSON.stringify({ origin, lots }), {
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
  const lots = await loadPublishedLots(db);
  const html = renderDiscoverHtml(lots, origin);
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': PUBLIC_CACHE_CONTROL,
    },
  });
}
