/**
 * The public, machine-readable surface: `/llms.txt`, `/llms-full.txt`,
 * `/docs.md`, `/robots.txt`, `/sitemap.xml` and `/discover`.
 *
 * These documents used to be static files in `public/`, generated once from
 * the seed catalog and committed. That made them a second source of truth: the
 * inventory counts and `revision` strings inside `llms-full.txt` froze at the
 * moment somebody ran a generator, while the database moved on with every
 * booking — and the file's own heading promised "toàn bộ dữ liệu danh mục". An
 * AI agent reading it would quote availability that no longer existed.
 *
 * **They are generated per request from the same D1 rows the catalog API reads.**
 * One projection (`toPublicLotProjection`, which strips owner names, phone
 * numbers, QR tokens and workspace ids), one `revision` formula, no copy to
 * drift. The Worker answers these paths before the assets binding, so a stale
 * file in `public/` could not shadow them even if one reappeared.
 *
 * Failure is answered honestly, and *differently from empty*: a document whose
 * read failed is a `503` saying the data is temporarily unreachable, with
 * `no-store`; only a successful read with nothing published says
 * "chưa có lô hoa nào được niêm yết". An agent quoting the failure as "sold
 * out" would be quoting a statement nobody made.
 */

import {
  CATALOG_UNAVAILABLE_MESSAGE,
  buildDocsMd,
  buildLlmsFullTxt,
  buildLlmsTxt,
  buildRobotsTxt,
  buildSitemapXml,
  renderCatalogUnavailableHtml,
  renderDiscoverHtml,
} from '../domain/aeo-projection.ts';
import type { D1Like } from './catalog.ts';
import { readPublishedLots } from './public-discovery-routes.ts';

/** Paths the Worker answers itself; kept beside the registry for the deploy test. */
export const PUBLIC_DOCUMENT_PATHS = [
  '/llms.txt',
  '/llms-full.txt',
  '/docs.md',
  '/robots.txt',
  '/sitemap.xml',
  '/discover',
  '/discover/',
] as const;

export type PublicDocumentPath = (typeof PUBLIC_DOCUMENT_PATHS)[number];

export function isPublicDocumentPath(pathname: string): pathname is PublicDocumentPath {
  return (PUBLIC_DOCUMENT_PATHS as readonly string[]).includes(pathname);
}

/**
 * The catalog is inventory, so it is cacheable for a short time and no longer:
 * a minute of staleness is a minute in which an agent could quote a sold-out
 * lot, and the documents carry a live `revision` per lot so a reader can tell
 * whether what it holds is current.
 */
const CATALOG_CACHE = 'public, max-age=60';

/**
 * What a document says when the catalogue could not be read.
 *
 * It is served as a `503`, never as an empty catalogue: "no lots are published"
 * and "the inventory could not be read" are different claims, and only the first
 * is about the market. The text documents say so in prose; `/discover` renders a
 * page that carries `data-catalog-status="unavailable"`. Nothing here names a
 * table, a binding or an error.
 */
function unavailable(pathname: PublicDocumentPath, origin: string): Response {
  const headers = {
    'cache-control': 'no-store',
    'retry-after': '60',
  };
  if (pathname === '/discover' || pathname === '/discover/') {
    return new Response(renderCatalogUnavailableHtml(origin), {
      status: 503,
      headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(
    `# Tạm thời không truy cập được dữ liệu danh mục\n\n${CATALOG_UNAVAILABLE_MESSAGE}\n`,
    {
      status: 503,
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    },
  );
}

function text(body: string, contentType: string, cache: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': cache },
  });
}

/**
 * Renders one public document. `origin` is the request's own origin, so links
 * inside `llms.txt` and `sitemap.xml` point at the host that served them rather
 * than at a placeholder.
 */
export async function handlePublicDocument(
  db: D1Like | null,
  pathname: PublicDocumentPath,
  origin: string,
): Promise<Response> {
  switch (pathname) {
    case '/llms.txt':
      return text(buildLlmsTxt(origin), 'text/plain', CATALOG_CACHE);

    case '/docs.md':
      return text(buildDocsMd(origin), 'text/markdown', 'public, max-age=300');

    case '/robots.txt':
      return text(buildRobotsTxt(origin), 'text/plain', 'public, max-age=300');

    case '/sitemap.xml':
      return text(buildSitemapXml(origin), 'application/xml', 'public, max-age=300');

    case '/llms-full.txt': {
      const read = await readPublishedLots(db);
      if (!read.ok) return unavailable(pathname, origin);
      return text(buildLlmsFullTxt(read.lots, origin), 'text/plain', CATALOG_CACHE);
    }

    case '/discover':
    case '/discover/': {
      const read = await readPublishedLots(db);
      if (!read.ok) return unavailable(pathname, origin);
      return text(renderDiscoverHtml(read.lots, origin), 'text/html', CATALOG_CACHE);
    }
  }
}
