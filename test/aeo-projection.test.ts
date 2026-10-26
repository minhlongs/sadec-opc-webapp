import { describe, expect, it } from 'vitest';
import {
  SAMPLE_LOTS,
  buildAgentJsonSchemas,
  buildCatalogJsonLd,
  buildDocsMd,
  buildLlmsFullTxt,
  buildLlmsTxt,
  buildLotJsonLd,
  buildRobotsTxt,
  buildSitemapXml,
  computeLotRevision,
  renderDiscoverHtml,
  toPublicLotProjection,
} from '../src/domain/aeo-projection.ts';
import type { SupplyLotRow } from '../src/ops/b2b-catalog.ts';

function makeRawLotRow(overrides?: Partial<SupplyLotRow>): SupplyLotRow & {
  nursery_name: string;
  hamlet_area: string;
  fulfillment_score_bps: number;
  owner_name?: string;
  phone?: string;
  tax_code?: string;
  buyer_contact_phone?: string;
} {
  return {
    id: 'lot-test-01',
    lot_code: 'SDEC-LOT-T01',
    nursery_workspace_id: 'ws-secret-nursery-01',
    name: 'Cúc Mâm Xôi Vàng Tuyển Chọn',
    mode: 'SEASONAL_PREORDER',
    species: 'Chrysanthemum morifolium',
    grade: 'A+',
    pot_diameter_cm: 40,
    height_cm: 75,
    canopy_cm: 100,
    bud_specification: 'Tán tròn đều 100cm, nụ kim 100%',
    media_proof_url: 'https://images.example.test/cuc-mam-xoi.jpg',
    unit: 'cặp',
    unit_price_vnd: 300000,
    deposit_rate_bps: 4000,
    moq_units: 20,
    total_units: 200,
    available_units: 150,
    cut_or_ship_date: '2027-01-28',
    qr_lot_token: 'SDECQR.secret-payload.secret-signature',
    status: 'PUBLISHED',
    created_at: '2026-10-25T00:00:00.000Z',
    updated_at: '2026-10-25T01:00:00.000Z',
    nursery_name: 'Vườn Hoa Tư Kiểng',
    hamlet_area: 'Tân Quy Đông, Sa Đéc',
    fulfillment_score_bps: 9850,
    owner_name: 'Nguyễn Văn Tư (Secret Owner PII)',
    phone: '0909999888',
    tax_code: '1400999888',
    buyer_contact_phone: '0911222333',
    ...overrides,
  };
}

describe('aeo-projection single-source-of-truth engine', () => {
  it('computeLotRevision is deterministic and changes when available_units or status changes', () => {
    const baseLot = makeRawLotRow();
    const rev1 = computeLotRevision(baseLot);
    const rev2 = computeLotRevision(baseLot);

    expect(rev1).toBe(rev2);
    expect(rev1).toBe('lot-test-01:u150:PUBLISHED:2026-10-25T01:00:00.000Z');

    const revAfterBooking = computeLotRevision({
      ...baseLot,
      available_units: 130,
    });
    expect(revAfterBooking).not.toBe(rev1);
    expect(revAfterBooking).toContain(':u130:');

    const revSoldOut = computeLotRevision({
      ...baseLot,
      available_units: 0,
      status: 'SOLD_OUT',
    });
    expect(revSoldOut).not.toBe(revAfterBooking);
    expect(revSoldOut).toContain(':SOLD_OUT:');
  });

  it('toPublicLotProjection strips all PII and internal tokens while computing exact integer VND MOQ quote', () => {
    const raw = makeRawLotRow();
    const projected = toPublicLotProjection(raw);
    const keys = Object.keys(projected);

    // Must never expose PII or internal tokens
    expect(keys).not.toContain('owner_name');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('qr_lot_token');
    expect(keys).not.toContain('nursery_workspace_id');
    expect(keys).not.toContain('tax_code');
    expect(keys).not.toContain('buyer_contact_phone');
    expect(keys).not.toContain('media_proof_url');
    expect(keys).not.toContain('created_at');
    expect(keys).not.toContain('updated_at');

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('Nguyễn Văn Tư');
    expect(serialized).not.toContain('0909999888');
    expect(serialized).not.toContain('SDECQR.secret');
    expect(serialized).not.toContain('ws-secret-nursery-01');

    // Verify MOQ quote: 20 units * 300,000 VND = 6,000,000 VND
    // Deposit 40% (4000 bps) = 2,400,000 VND; Platform fee 3% (300 bps) = 180,000 VND
    expect(projected.sample_moq_quote).toEqual({
      grossTotalVnd: 6000000,
      depositRequiredVnd: 2400000,
      platformFeeVnd: 180000,
      estimatedBuyerTotalVnd: 6180000,
    });
  });

  it('buildLotJsonLd produces Schema.org Product with VND Offer and QuantitativeValue MOQ bounds', () => {
    const lot = toPublicLotProjection(makeRawLotRow());
    const jsonLd = buildLotJsonLd(lot, 'https://sadec-flow.example.com');

    expect(jsonLd['@type']).toBe('Product');
    expect(jsonLd['sku']).toBe('SDEC-LOT-T01');
    expect(jsonLd['url']).toBe('https://sadec-flow.example.com/discover');

    const offers = jsonLd['offers'] as Record<string, unknown>;
    expect(offers['@type']).toBe('Offer');
    expect(offers['priceCurrency']).toBe('VND');
    expect(offers['price']).toBe(300000);
    expect(offers['availability']).toBe('https://schema.org/InStock');

    const eligibleQuantity = offers['eligibleQuantity'] as Record<string, unknown>;
    expect(eligibleQuantity['@type']).toBe('QuantitativeValue');
    expect(eligibleQuantity['minValue']).toBe(20);
    expect(eligibleQuantity['maxValue']).toBe(150);

    // Sold out check
    const soldOutLot = toPublicLotProjection(
      makeRawLotRow({ status: 'SOLD_OUT', available_units: 0 }),
    );
    const soldOutLd = buildLotJsonLd(soldOutLot, 'https://sadec-flow.example.com');
    const soldOutOffers = soldOutLd['offers'] as Record<string, unknown>;
    expect(soldOutOffers['availability']).toBe('https://schema.org/OutOfStock');
  });

  it('buildCatalogJsonLd builds @graph with WholesaleStore, OfferCatalog, and FAQPage', () => {
    const catalogLd = buildCatalogJsonLd(SAMPLE_LOTS, 'https://sadec-flow.example.com');

    expect(catalogLd['@context']).toBe('https://schema.org');
    const graph = catalogLd['@graph'] as Record<string, unknown>[];
    expect(Array.isArray(graph)).toBe(true);
    expect(graph).toHaveLength(3);

    const storeNode = graph[0]!;
    expect(storeNode['@type']).toEqual(['WholesaleStore', 'Organization']);
    expect(storeNode['@id']).toBe('https://sadec-flow.example.com/#store');

    const catalogNode = graph[1]!;
    expect(catalogNode['@type']).toBe('OfferCatalog');
    const items = catalogNode['itemListElement'] as unknown[];
    expect(items).toHaveLength(SAMPLE_LOTS.length);

    const faqNode = graph[2]!;
    expect(faqNode['@type']).toBe('FAQPage');
    const questions = faqNode['mainEntity'] as unknown[];
    expect(questions.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(questions)).toContain('Bộ đôi Chắc tiền & Giá gốc');
    expect(JSON.stringify(questions)).toContain('hoàn cọc 100%');
  });

  it('buildLlmsTxt and buildLlmsFullTxt document invariants (platformOutlayVnd === 0) and WebMCP tools', () => {
    const origin = 'https://sadec-flow.example.com';
    const llmsTxt = buildLlmsTxt(origin);
    expect(llmsTxt).toContain('# Sa Đéc Flow');
    expect(llmsTxt).toContain('/api/public/catalog');
    expect(llmsTxt).toContain('/api/schema');
    expect(llmsTxt).toContain('/api/discover');
    expect(llmsTxt).toContain('/llms-full.txt');
    expect(llmsTxt).toContain('/docs.md');

    const llmsFull = buildLlmsFullTxt(SAMPLE_LOTS, origin);
    expect(llmsFull).toContain('Bộ đôi Chắc tiền & Giá gốc');
    expect(llmsFull).toContain('Thương lái truyền thống');
    expect(llmsFull).toContain('platformOutlayVnd === 0');
    expect(llmsFull).toContain('CRC16-CCITT');
    expect(llmsFull).toContain('3000..5000 bps');
    expect(llmsFull).toContain('200..500 bps');
    expect(llmsFull).toContain('window.__SADEC_AGENT_BRIDGE__');
    expect(llmsFull).toContain('listSupplyLots');
    expect(llmsFull).toContain('quoteBooking');
    expect(llmsFull).toContain('proposeBooking');
    expect(llmsFull).toContain('verifyQrToken');
  });

  it('buildDocsMd, buildRobotsTxt, and buildSitemapXml return valid discovery texts', () => {
    const origin = 'https://sadec-flow.example.com';
    const docs = buildDocsMd(origin);
    expect(docs).toContain('Dual-Surface');
    expect(docs).toContain('/api/public/catalog');
    expect(docs).toContain('VietQR Escrow');

    const robots = buildRobotsTxt(origin);
    expect(robots).toContain('User-agent: GPTBot');
    expect(robots).toContain('User-agent: ClaudeBot');
    expect(robots).toContain('User-agent: PerplexityBot');
    expect(robots).toContain('Allow: /api/public/*');
    expect(robots).toContain('Sitemap: https://sadec-flow.example.com/sitemap.xml');

    const sitemap = buildSitemapXml(origin);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap).toContain('<loc>https://sadec-flow.example.com/discover</loc>');
    expect(sitemap).toContain('<loc>https://sadec-flow.example.com/llms.txt</loc>');
  });

  it('renderDiscoverHtml renders semantic HTML5 with JSON-LD and zero PII leakage', () => {
    const projected = toPublicLotProjection(makeRawLotRow());
    const html = renderDiscoverHtml([projected], 'https://sadec-flow.example.com');

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('<main>');
    expect(html).toContain('<article');
    expect(html).toContain('<table>');
    expect(html).toContain('<dl>');
    expect(html).toContain('Cúc Mâm Xôi Vàng Tuyển Chọn');
    expect(html).toContain('Bộ đôi Chắc tiền &amp; Giá gốc');
    expect(html).toContain('Thương lái truyền thống');

    // Zero PII
    expect(html).not.toContain('owner_name');
    expect(html).not.toContain('Nguyễn Văn Tư');
    expect(html).not.toContain('0909999888');
    expect(html).not.toContain('qr_lot_token');
    expect(html).not.toContain('nursery_workspace_id');
  });

  it('buildAgentJsonSchemas returns Draft 2020-12 JSON Schemas for all 4 WebMCP tools', () => {
    const schemas = buildAgentJsonSchemas();
    const toolKeys = Object.keys(schemas);

    expect(toolKeys).toEqual([
      'listSupplyLots',
      'quoteBooking',
      'proposeBooking',
      'verifyQrToken',
    ]);

    for (const key of toolKeys) {
      const toolSchema = schemas[key] as Record<string, unknown>;
      expect(toolSchema['$schema']).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
      expect(toolSchema['type']).toBe('object');
    }
  });
});
