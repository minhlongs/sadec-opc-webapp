/**
 * Single-Source-of-Truth Projection Engine for AEO (Answer Engine Optimization)
 * and GEO (Generative Engine Optimization) in Sa Đéc Flow.
 *
 * Pure module (0 I/O). Projects internal supply lot rows into:
 *  - Stripped PublicLotProjection (100% PII-free)
 *  - Deterministic lot revisions for optimistic concurrency
 *  - Schema.org JSON-LD (WholesaleStore, OfferCatalog, Product, Offer, FAQPage)
 *  - llms.txt & llms-full.txt
 *  - docs.md (Markdown specification for LLMs/AI Agents)
 *  - robots.txt & sitemap.xml
 *  - Semantic HTML5 for discovery (/discover and /api/discover)
 *  - Agent JSON Schemas (Draft 2020-12) for Browser WebMCP tools
 *
 * Invariant: Platform Working Capital Outlay is ALWAYS 0 VND.
 * platformOutlayVnd === 0
 */

import { calculateBookingQuote, type BookingQuoteResult } from './escrow-ledger.ts';
import type { SupplyLotRow } from '../ops/b2b-catalog.ts';

/**
 * Publicly exposed lot projection with all PII and internal keys stripped out.
 * Safe for anonymous discovery, crawlers, and AI agents.
 */
export interface PublicLotProjection {
  id: string;
  lot_code: string;
  name: string;
  mode: 'WEEKLY_CATALOG' | 'SEASONAL_PREORDER';
  species: string;
  grade: string;
  pot_diameter_cm: number;
  height_cm: number;
  canopy_cm: number;
  bud_specification: string;
  unit: string;
  unit_price_vnd: number;
  deposit_rate_bps: number;
  moq_units: number;
  total_units: number;
  available_units: number;
  cut_or_ship_date: string;
  status: string;
  nursery_name: string;
  hamlet_area: string;
  fulfillment_score_bps: number;
  revision: string;
  sample_moq_quote: BookingQuoteResult;
}

/**
 * Computes deterministic revision hash for optimistic concurrency.
 * Changes whenever available units, status, or update timestamp change.
 */
export function computeLotRevision(
  lot: Pick<SupplyLotRow, 'id' | 'available_units' | 'status' | 'updated_at'>,
): string {
  return `${lot.id}:u${lot.available_units}:${lot.status}:${lot.updated_at}`;
}

/**
 * Maps a database SupplyLotRow to a PII-free PublicLotProjection.
 * Strips owner_name, phone, qr_lot_token, nursery_workspace_id, etc.
 */
export function toPublicLotProjection(
  row: SupplyLotRow & {
    nursery_name?: string;
    hamlet_area?: string;
    fulfillment_score_bps?: number;
  },
): PublicLotProjection {
  const revision = computeLotRevision(row);
  const sample_moq_quote = calculateBookingQuote({
    quantity: row.moq_units,
    unitPriceVnd: row.unit_price_vnd,
    depositRateBps: row.deposit_rate_bps,
    platformFeeBps: 300,
  });

  return {
    id: row.id,
    lot_code: row.lot_code,
    name: row.name,
    mode: row.mode,
    species: row.species,
    grade: row.grade,
    pot_diameter_cm: row.pot_diameter_cm,
    height_cm: row.height_cm,
    canopy_cm: row.canopy_cm,
    bud_specification: row.bud_specification,
    unit: row.unit,
    unit_price_vnd: row.unit_price_vnd,
    deposit_rate_bps: row.deposit_rate_bps,
    moq_units: row.moq_units,
    total_units: row.total_units,
    available_units: row.available_units,
    cut_or_ship_date: row.cut_or_ship_date,
    status: row.status,
    nursery_name: row.nursery_name ?? 'Nhà vườn Sa Đéc',
    hamlet_area: row.hamlet_area ?? 'Làng hoa Sa Đéc, Đồng Tháp',
    fulfillment_score_bps: row.fulfillment_score_bps ?? 9800,
    revision,
    sample_moq_quote,
  };
}

/**
 * Builds Schema.org Product JSON-LD for a single lot.
 */
export function buildLotJsonLd(
  lot: PublicLotProjection,
  origin: string,
): Record<string, unknown> {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const inStock = lot.status === 'PUBLISHED' && lot.available_units > 0;

  return {
    '@type': 'Product',
    '@id': `${cleanOrigin}/discover#lot-${lot.lot_code}`,
    sku: lot.lot_code,
    name: lot.name,
    description: `${lot.name} (${lot.species}) - Hạng ${lot.grade}. Quy cách nụ: ${lot.bud_specification}. Đường kính chậu ${lot.pot_diameter_cm}cm, cao ${lot.height_cm}cm, tán ${lot.canopy_cm}cm. Nhà vườn: ${lot.nursery_name} (${lot.hamlet_area}).`,
    brand: {
      '@type': 'Brand',
      name: lot.nursery_name,
    },
    additionalProperty: [
      {
        '@type': 'PropertyValue',
        name: 'pot_diameter_cm',
        value: lot.pot_diameter_cm,
        unitText: 'cm',
      },
      {
        '@type': 'PropertyValue',
        name: 'height_cm',
        value: lot.height_cm,
        unitText: 'cm',
      },
      {
        '@type': 'PropertyValue',
        name: 'canopy_cm',
        value: lot.canopy_cm,
        unitText: 'cm',
      },
      {
        '@type': 'PropertyValue',
        name: 'bud_specification',
        value: lot.bud_specification,
      },
      {
        '@type': 'PropertyValue',
        name: 'deposit_rate_bps',
        value: lot.deposit_rate_bps,
        unitText: 'basis_points',
      },
      {
        '@type': 'PropertyValue',
        name: 'fulfillment_score_bps',
        value: lot.fulfillment_score_bps,
        unitText: 'basis_points',
      },
      {
        '@type': 'PropertyValue',
        name: 'revision',
        value: lot.revision,
      },
    ],
    offers: {
      '@type': 'Offer',
      priceCurrency: 'VND',
      price: lot.unit_price_vnd,
      priceValidUntil: lot.cut_or_ship_date,
      itemCondition: 'https://schema.org/NewCondition',
      availability: inStock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      eligibleQuantity: {
        '@type': 'QuantitativeValue',
        minValue: lot.moq_units,
        maxValue: lot.available_units,
        unitText: lot.unit,
      },
      seller: {
        '@type': 'Organization',
        name: lot.nursery_name,
      },
      url: `${cleanOrigin}/discover`,
    },
    url: `${cleanOrigin}/discover`,
  };
}

/**
 * Builds standard FAQ items in Vietnamese covering B2B Floriculture and VietQR Escrow.
 */
function buildFaqGraph(): Record<string, unknown> {
  return {
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'Mua sỉ hoa kiểng Sa Đéc đi TP.HCM ở đâu uy tín, có bảo chứng cọc?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Sa Đéc Flow kết nối trực tiếp các nhà vườn uy tín tại Làng hoa Sa Đéc (Tân Quy Đông, Sa Nhiên, Tân Khánh Đông, Cai Dao) với shop hoa và vựa kiểng TP.HCM, định vị "Bộ đôi Chắc tiền & Giá gốc": nhà vườn cầm chắc cọc VietQR Escrow 30-50% không lo bùng cọc Tết; shop hoa mua thẳng giá gốc không bị kê chênh lệch.',
        },
      },
      {
        '@type': 'Question',
        name: 'Cơ chế đặt cọc VietQR Escrow 0đ Outlay hoạt động thế nào?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Người mua quét mã VietQR động chuẩn EMVCo đặt cọc (30%-50%) vào tài khoản ký quỹ. Tiền cọc được giữ an toàn tại tài khoản bảo chứng; Sàn Sa Đéc Flow ứng vốn 0 VND (platformOutlayVnd === 0). Tiền chỉ được giải ngân cho nhà vườn khi hàng đã qua kiểm định tại Hub Sa Đéc và bàn giao thành công tại TP.HCM.',
        },
      },
      {
        '@type': 'Question',
        name: 'Chính sách bảo vệ người mua: Nếu hoa giao sai quy cách nụ/tán thì sao?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Sa Đéc Flow cam kết hoàn cọc 100% cho shop hoa TP.HCM nếu lô hoa giao sai quy cách nụ, chiều cao, đường kính tán cam kết hoặc bị gãy dập do lỗi nhà vườn. Tiền cọc nằm trong tài khoản Escrow của sàn bảo đảm shop không bị mất tiền oan.',
        },
      },
      {
        '@type': 'Question',
        name: 'Làm sao AI Agent kết nối qua WebMCP với Sa Đéc Flow?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Trang hỗ trợ WebMCP qua navigator.modelContext và window.__SADEC_AGENT_BRIDGE__ với 4 công cụ chuẩn: listSupplyLots, quoteBooking, proposeBooking, verifyQrToken. Công cụ proposeBooking tuân thủ Zero Auto-Spend: chỉ dựng đề xuất lên Proposal HUD để con người xác nhận trước khi thanh toán.',
        },
      },
      {
        '@type': 'Question',
        name: 'Tỷ lệ cọc và phí sàn là bao nhiêu?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Tỷ lệ đặt cọc nằm trong khung 30% - 50% (3000..5000 bps) tùy thuộc vào quy cách đơn hàng và loại hoa. Phí nền tảng nằm trong khung 2% - 5% (200..500 bps), tính trên giá trị giao dịch thực tế sau kiểm định, sàn 0đ kê giá trung gian.',
        },
      },
      {
        '@type': 'Question',
        name: 'Kiểm định chất lượng gồm những chốt chặn nào?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Quy trình gồm 3 chốt chặn: Chốt 0 (Nhà vườn đăng ký lô kèm QR), Chốt 1 (Hub Sa Đéc nghiệm thu quy cách nụ, tán cây, đóng sọt và dán QR niêm phong), Chốt 2 (Shop TP.HCM quét QR đối chiếu biên bản kiểm định trước khi nhận hàng và đối soát).',
        },
      },
    ],
  };
}

/**
 * Builds complete Schema.org JSON-LD catalog graph.
 */
export function buildCatalogJsonLd(
  lots: readonly PublicLotProjection[],
  origin: string,
): Record<string, unknown> {
  const cleanOrigin = origin.replace(/\/+$/, '');

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['WholesaleStore', 'Organization'],
        '@id': `${cleanOrigin}/#store`,
        name: 'Sa Đéc Flow — Sàn Giao Dịch Hoa Kiểng B2B Sa Đéc → TP.HCM',
        description:
          'Sàn giao dịch hoa kiểng B2B chuyên nghiệp kết nối nhà vườn Sa Đéc với vựa hoa TP.HCM qua cơ chế ký quỹ VietQR Escrow 0đ ứng vốn và kiểm định cross-docking.',
        url: cleanOrigin,
        areaServed: [
          {
            '@type': 'AdministrativeArea',
            name: 'Đồng Tháp',
          },
          {
            '@type': 'AdministrativeArea',
            name: 'Thành phố Hồ Chí Minh',
          },
        ],
        knowsAbout: [
          'Hoa kiểng Sa Đéc',
          'Cúc mâm xôi Tết',
          'Mai vàng giảo Thủ Đức',
          'Kiểng lá xuất tuần',
          'VietQR Escrow B2B',
        ],
      },
      {
        '@type': 'OfferCatalog',
        '@id': `${cleanOrigin}/#catalog`,
        name: 'Danh mục Lô Hoa Kiểng B2B',
        numberOfItems: lots.length,
        itemListElement: lots.map((lot) => buildLotJsonLd(lot, cleanOrigin)),
      },
      buildFaqGraph(),
    ],
  };
}

/**
 * Builds llms.txt index file according to llmstxt.org specification.
 */
export function buildLlmsTxt(origin: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');

  return `# Sa Đéc Flow

> Sàn giao dịch hoa kiểng B2B đặt trước & gom hàng cross-docking Sa Đéc → TP.HCM với cơ chế bảo chứng cọc VietQR Escrow 0đ ứng vốn (Zero Platform Outlay).

## Machine-Readable Endpoints

- [Danh mục lô sỉ công khai](${cleanOrigin}/api/public/catalog): API JSON danh sách lô hoa kiểng (đã lọc PII, kèm revision kiểm tra xung đột).
- [Đặc tả Schema.org & JSON Schema](${cleanOrigin}/api/schema): JSON-LD Graph và WebMCP Agent JSON Schemas.
- [Trang khám phá HTML ngữ nghĩa](${cleanOrigin}/api/discover): HTML5 nhẹ tối ưu cho LLM crawler kèm JSON-LD nhúng.
- [Toàn bộ dữ liệu danh mục & Bất biến](${cleanOrigin}/llms-full.txt): Văn bản tổng hợp toàn bộ lô hoa kiểng, quy tắc kinh doanh và giao thức WebMCP.
- [Tài liệu kỹ thuật Markdown](${cleanOrigin}/docs.md): Hướng dẫn kiến trúc Dual-Surface, cơ chế VietQR Escrow và tích hợp Agent.

## Quick Facts

- **Vùng nguyên liệu:** Làng hoa Sa Đéc, Tỉnh Đồng Tháp (Tân Quy Đông, Sa Nhiên, Tân Khánh Đông).
- **Thị trường tiêu thụ:** TP.HCM (Chợ đầu mối Hồ Thị Kỷ, Đầm Sen, Hậu Giang và các shop hoa tươi/cảnh quan).
- **Bất biến vốn sàn:** Sàn Sa Đéc Flow ứng vốn 0 VND (platformOutlayVnd === 0).
- **Giao thức WebMCP:** Cung cấp 4 công cụ (listSupplyLots, quoteBooking, proposeBooking, verifyQrToken) qua navigator.modelContext & window.__SADEC_AGENT_BRIDGE__.
`;
}

/**
 * Builds llms-full.txt containing full catalog, business invariants, and WebMCP protocol.
 */
export function buildLlmsFullTxt(
  lots: readonly PublicLotProjection[],
  origin: string,
): string {
  const cleanOrigin = origin.replace(/\/+$/, '');

  const lotsBlock = lots.length === 0
    ? '_Hiện chưa có lô hoa nào được niêm yết._\n'
    : lots
        .map(
          (lot, idx) => `### Lô ${idx + 1}: [${lot.lot_code}] ${lot.name}
- Mã lô: ${lot.lot_code}
- Tên hoa/kiểng: ${lot.name}
- Chủng loại (Species): ${lot.species}
- Phân loại hàng (Grade): ${lot.grade}
- Chế độ cung ứng: ${lot.mode === 'WEEKLY_CATALOG' ? 'Hàng nhập tuần' : 'Sổ đặt trước vụ Tết'}
- Quy cách kích thước: Đường kính chậu ${lot.pot_diameter_cm}cm • Chiều cao ${lot.height_cm}cm • Tán rộng ${lot.canopy_cm}cm
- Tiêu chuẩn nụ/lá: ${lot.bud_specification}
- Đơn vị tính: ${lot.unit}
- Giá sỉ xuất vườn: ${lot.unit_price_vnd.toLocaleString('vi-VN')} VND / ${lot.unit}
- Số lượng tối thiểu (MOQ): ${lot.moq_units} ${lot.unit}
- Tổng số lượng lô: ${lot.total_units} ${lot.unit}
- Số lượng còn lại: ${lot.available_units} ${lot.unit}
- Tỷ lệ cọc yêu cầu: ${(lot.deposit_rate_bps / 100).toFixed(1)}% (${lot.deposit_rate_bps} bps)
- Ngày xuất vườn / cắt cành dự kiến: ${lot.cut_or_ship_date}
- Nhà vườn: ${lot.nursery_name} (${lot.hamlet_area})
- Điểm uy tín nhà vườn: ${(lot.fulfillment_score_bps / 100).toFixed(1)}%
- Mã phiên bản tồn kho (Revision): \`${lot.revision}\`
- Báo giá mẫu MOQ (${lot.moq_units} ${lot.unit}):
  + Tiền hàng gốc: ${lot.sample_moq_quote.grossTotalVnd.toLocaleString('vi-VN')} VND
  + Tiền cọc yêu cầu: ${lot.sample_moq_quote.depositRequiredVnd.toLocaleString('vi-VN')} VND
  + Phí sàn ước tính (3%): ${lot.sample_moq_quote.platformFeeVnd.toLocaleString('vi-VN')} VND
  + Tổng thanh toán người mua ước tính: ${lot.sample_moq_quote.estimatedBuyerTotalVnd.toLocaleString('vi-VN')} VND
`,
        )
        .join('\n');

  return `# Sa Đéc Flow — Toàn Bộ Dữ Liệu Danh Mục & Đặc Tả Kỹ Thuật (Full LLMs Knowledge Base)
Origin: ${cleanOrigin}

## 0. Định Vị Giá Trị Cốt Lõi: "Bộ đôi Chắc tiền & Giá gốc"

- **Với Nhà Vườn Sa Đéc (Tân Quy Đông, Sa Nhiên, Cai Dao):** Cầm chắc 30–50% tiền cọc tươi qua VietQR Escrow bảo chứng trước khi bứng chậu; đúng quy cách xuất Hub là nhận đủ tiền ngay sáng hôm sau; xóa sổ nỗi lo thương lái ép giá hoặc bùng cọc ngày 29–30 Tết.
- **Với Shop Hoa & Vựa Sỉ TP.HCM (Hồ Thị Kỷ, Đầm Sen, Thủ Đức):** Mua thẳng giá gốc tại vườn (sàn thu phí dịch vụ minh bạch 2–5%, 0đ kê giá trung gian); tiền cọc khóa an toàn trong Escrow; cam kết hoàn cọc 100% nếu hoa giao sai quy cách nụ, tán, chiều cao.

| Tiêu chí đối chiếu | Thương lái truyền thống | Sa Đéc Flow (VietQR Escrow) |
|---|---|---|
| **Chênh lệch giá mua sỉ** | Đội giá 20%–35% qua 2–3 tầng cò | Giá gốc nhà vườn + Phí sàn 2%–5% (0đ kê giá) |
| **An toàn tiền cọc** | Cọc miệng/chuyển khoản cá nhân, dễ bùng cọc Tết | Khóa trong VietQR Escrow (30%–50%), bảo chứng 2 chiều |
| **Kiểm định quy cách** | Xem qua ảnh Zalo mờ, dễ bị tráo chậu/nụ điếc | Kiểm định kép Chốt 1 (Hub Sa Đéc) & Chốt 2 (Shop TP.HCM) bằng QR HMAC-SHA256 |
| **Bảo vệ khi hàng lỗi** | Khó đòi lại tiền cọc, chủ shop tự chịu | Hoàn cọc 100% tự động từ sổ cái Escrow nếu sai quy cách nụ/tán |

## 1. Danh Mục Lô Hoa Kiểng Hiện Hữu

${lotsBlock}

## 2. Business Invariants (Quy Tắc Kinh Doanh Bất Biến)

1. **Sàn Ứng Vốn 0 VND (Zero Platform Outlay):**
   - Công thức cốt lõi: \`platformOutlayVnd === 0\`
   - Cân bằng dòng tiền: \`totalCollectedFromBuyerVnd === nurseryPayoutVnd + buyerRefundVnd + platformFeeRetainedVnd\`
   - Sàn Sa Đéc Flow KHÔNG BAO GIỜ ứng vốn lưu động để thanh toán hộ hoặc chịu rủi ro bùng cọc của hai phía.

2. **Cơ Chế Tiền Tệ & Định Dạng Số:**
   - Mọi khoản tiền là số nguyên VND (\`assertSafeVnd\`), cấm hoàn toàn số thập phân (float) trong tính toán tài chính.
   - Tỷ lệ đặt cọc: \`depositRateBps\` nằm trong khoảng \`3000..5000 bps\` (30% đến 50%).
   - Phí nền tảng: \`platformFeeBps\` nằm trong khoảng \`200..500 bps\` (2% đến 5%).

3. **Mã Thanh Toán VietQR Chuẩn EMVCo ISO/IEC 18004:**
   - Thuật toán checksum: \`CRC16-CCITT\` (đa thức \`0x1021\`, giá trị khởi tạo \`0xFFFF\`, không XOR kết quả).
   - Mã VietQR động được tạo riêng cho đợt cọc (\`DEP\`) và đợt quyết toán nhận hàng (\`BAL\`).

4. **Kiểm Soát Xung Đột Lạc Quan (Optimistic Concurrency Control):**
   - Thuộc tính \`revision\` được tính theo công thức: \`\${lot_id}:u\${available_units}:\${status}:\${updated_at}\`.
   - Khi AI Agent hoặc người dùng gửi lệnh đặt giữ (\`POST /api/b2b/bookings/create\`), trường \`expected_revision\` được đối chiếu. Nếu tồn kho bị thay đổi giữa lúc xem và lúc đặt, giao dịch bị từ chối với mã lỗi \`409 Conflict\`.

## 3. WebMCP Browser Agent Bridge Protocol

Sa Đéc Flow phơi bày giao diện WebMCP cho các trình duyệt AI Agent qua \`window.__SADEC_AGENT_BRIDGE__\` và \`navigator.modelContext\`.

Gồm 4 công cụ (Tools):
- \`listSupplyLots(mode?: 'WEEKLY_CATALOG' | 'SEASONAL_PREORDER')\`: Liệt kê các lô hoa kiểng đang mở bán kèm revision.
- \`quoteBooking(params: { quantity, unitPriceVnd, depositRateBps, platformFeeBps })\`: Tính toán bảng phân tích tiền cọc và phí sàn.
- \`proposeBooking(params: { lotId, quantity, expectedRevision, buyerShopName, buyerContactPhone, destinationMarket, note })\`: Tạo đề xuất đặt hàng hiển thị trên Agent Co-Pilot Proposal HUD (Zero Auto-Spend: bắt buộc người dùng bấm xác nhận).
- \`verifyQrToken(params: { token })\`: Xác thực chữ ký số HMAC-SHA256 của thẻ QR lô hoặc kiện hàng.
`;
}

/**
 * Builds docs.md explaining the Dual-Surface architecture, APIs, and WebMCP integration.
 */
export function buildDocsMd(origin: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');

  return `# Sa Đéc Flow — B2B Floriculture Dual-Surface Architecture Docs

## Tổng Quan Kiến Trúc Dual-Surface

Sa Đéc Flow được thiết kế theo mô hình **Dual-Surface (Human UI + AI Agent Native)**:
1. **Mặt giao diện con người (Human Surface):**
   - Giao diện Biophilic Bento 2027 tối ưu cho cả màn hình điện thoại \`390px\` ngoài nắng vườn Sa Đéc và màn hình \`1440px\` tại quầy quản lý vựa hoa TP.HCM.
   - Hộp lệnh nhanh \`Cmd+K\` / \`Ctrl+K\` điều hướng tức thì.
   - Công tắc chuyển đổi xem dữ liệu Human ↔ Agent JSON-LD.
   - Agent Proposal HUD: Khối nổi hiển thị đề xuất từ AI Agent để người dùng bấm nút duyệt VietQR, đảm bảo nguyên tắc Zero Auto-Spend.

2. **Mặt giao tiếp tác tử AI (Agent Surface):**
   - Đơn nguồn chiếu dữ liệu (Single Source of Truth): Từ D1 DB chiếu ra \`Schema.org\` JSON-LD, \`llms.txt\`, \`llms-full.txt\`, \`docs.md\`, và semantic HTML.
   - WebMCP Browser Tools: AI Agent hoạt động ngay trong tab trình duyệt thông qua \`window.__SADEC_AGENT_BRIDGE__\` và \`navigator.modelContext\`.
   - Kiểm soát xung đột lạc quan: Dùng \`revision = computeLotRevision(lot)\` chống tình trạng đặt trùng khi nhiều Agent cùng săn hàng sỉ.

## Danh Sách API Endpoints

### 1. Public Discovery Endpoints (Không Cần Xác Thực)
- \`GET /api/public/catalog\` — Trả về danh sách lô hoa kiểng sỉ (\`PublicLotProjection[]\`), hỗ trợ query \`?mode=WEEKLY_CATALOG|SEASONAL_PREORDER\`.
- \`GET /api/schema\` — Trả về Schema.org JSON-LD Catalog Graph & WebMCP Agent JSON Schemas.
- \`GET /api/discover\` — Trả về HTML5 ngữ nghĩa đầy đủ cho các bot AI thu thập thông tin.
- \`GET /discover\` — Trang hiển thị bảng danh mục tĩnh thân thiện với SEO & AEO.

### 2. B2B Booking & Ops Endpoints (Yêu Cầu Xác Thực Cloudflare Access)
- \`GET /api/b2b/lots\` — Danh sách lô hoa đầy đủ quyền quản trị.
- \`POST /api/b2b/lots/create\` — Nhà vườn đăng ký lô hoa mới.
- \`POST /api/b2b/bookings/create\` — Tạo đơn đặt giữ (hỗ trợ \`expected_revision\`).
- \`GET /api/b2b/bookings\` — Danh sách đơn đặt của nhà vườn hoặc người mua.
- \`POST /api/b2b/ledger/record-deposit\` — Ghi nhận cọc chuyển khoản VietQR.
- \`POST /api/b2b/shipments/verify-hub\` — Hub Sa Đéc nghiệm thu và dán QR kiện.
- \`POST /api/b2b/shipments/inspect-settlement\` — Shop TP.HCM nghiệm thu và chốt quyết toán.

## Cơ Chế Bảo Chứng Cọc VietQR Escrow (0đ Ứng Vốn)

\`\`\`text
[Shop TP.HCM] --(1) Đặt giữ & Quét VietQR Cọc 30-50%--> [Tài Khoản Ký Quỹ Escrow]
                                                                |
[Nhà Vườn Sa Đéc] --(2) Giao hàng tới Hub Sa Đéc <---------------+ (Giữ an toàn, Sàn 0đ ứng vốn)
         |
    (Kiểm định Chốt 1: Quy cách nụ, tán, dán QR Kiện)
         |
[Xe Tải Lạnh Cross-Docking] ---> [Chợ Sỉ TP.HCM]
                                       |
    (Kiểm định Chốt 2: Shop quét QR & Đối soát số lượng)
                                       |
[Shop TP.HCM] --(3) Quét VietQR Tất Toán 50-70%--------> [Tài Khoản Ký Quỹ Escrow]
                                                                |
                                                 (4) Giải ngân tự động:
                                                 - Nhà vườn nhận đủ tiền hàng đạt chuẩn
                                                 - Sàn giữ lại 2-5% phí vận hành
                                                 - Hoàn tiền cọc nếu có lỗi từ nhà vườn
\`\`\`

## Hướng Dẫn Tích Hợp WebMCP Cho Agent

\`\`\`javascript
if (window.__SADEC_AGENT_BRIDGE__) {
  const bridge = window.__SADEC_AGENT_BRIDGE__;

  // 1. Tìm các lô cúc mâm xôi Tết
  const lots = await bridge.tools.listSupplyLots({ mode: 'SEASONAL_PREORDER' });

  // 2. Lấy báo giá mẫu
  const quote = await bridge.tools.quoteBooking({
    quantity: lots[0].moq_units,
    unitPriceVnd: lots[0].unit_price_vnd,
    depositRateBps: lots[0].deposit_rate_bps,
    platformFeeBps: 300,
  });

  // 3. Đề xuất đặt giữ (Human-in-the-loop duyệt)
  await bridge.tools.proposeBooking({
    lotId: lots[0].id,
    quantity: lots[0].moq_units,
    expectedRevision: lots[0].revision,
    buyerShopName: 'Shop Hoa Tươi Quận 1',
    buyerContactPhone: '0901234567',
    destinationMarket: 'Chợ Hồ Thị Kỷ',
    note: 'Giao sáng sớm trước 05:00',
  });
}
\`\`\`
`;
}

/**
 * Builds robots.txt welcoming modern AI crawlers to discovery assets while shielding private APIs.
 */
export function buildRobotsTxt(origin: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');

  return `# Robots.txt for Sa Đéc Flow (AEO/GEO Optimized)
# Policy: Welcome AI Agents, Search Engines, and Answer Engines to discovery surfaces.

User-agent: GPTBot
User-agent: ClaudeBot
User-agent: PerplexityBot
User-agent: Google-Extended
User-agent: CCBot
User-agent: Applebot-Extended
Allow: /
Allow: /discover
Allow: /api/discover
Allow: /api/public/*
Allow: /api/schema
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /docs.md
Disallow: /api/b2b/*
Disallow: /api/ops/*

User-agent: *
Allow: /
Allow: /discover
Allow: /api/discover
Allow: /api/public/*
Allow: /api/schema
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /docs.md
Disallow: /api/b2b/*
Disallow: /api/ops/*

Sitemap: ${cleanOrigin}/sitemap.xml
`;
}

/**
 * Builds XML Sitemap according to sitemaps.org standard.
 */
export function buildSitemapXml(origin: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const now = new Date().toISOString().split('T')[0] ?? '2026-10-25';

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${cleanOrigin}/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${cleanOrigin}/discover</loc>
    <lastmod>${now}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${cleanOrigin}/api/discover</loc>
    <lastmod>${now}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${cleanOrigin}/llms.txt</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${cleanOrigin}/llms-full.txt</loc>
    <lastmod>${now}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${cleanOrigin}/docs.md</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
</urlset>
`;
}

/**
 * Escapes HTML characters to prevent XSS in rendered templates.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders high-contrast, semantic HTML5 page for discovery.
 * Designed for sunlight legibility at 390px and clarity for AI scrapers.
 */
export function renderDiscoverHtml(
  lots: readonly PublicLotProjection[],
  origin: string,
): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const jsonLd = buildCatalogJsonLd(lots, cleanOrigin);

  const lotArticles = lots
    .map((lot) => {
      const modeLabel =
        lot.mode === 'WEEKLY_CATALOG' ? 'Hàng nhập tuần' : 'Sổ đặt Tết';
      const depositPct = (lot.deposit_rate_bps / 100).toFixed(0);

      return `      <article id="lot-${escapeHtml(lot.lot_code)}" class="lot-card">
        <header>
          <span class="badge ${lot.mode === 'WEEKLY_CATALOG' ? 'badge-weekly' : 'badge-seasonal'}">${escapeHtml(modeLabel)}</span>
          <span class="sku">Mã: <code>${escapeHtml(lot.lot_code)}</code></span>
          <h3>${escapeHtml(lot.name)}</h3>
          <p class="species"><em>${escapeHtml(lot.species)}</em> • Hạng <strong>${escapeHtml(lot.grade)}</strong></p>
        </header>
        <section class="specs">
          <p><strong>Quy cách:</strong> Chậu Ø${lot.pot_diameter_cm}cm • Cao ${lot.height_cm}cm • Tán ${lot.canopy_cm}cm</p>
          <p><strong>Tiêu chuẩn nụ/lá:</strong> ${escapeHtml(lot.bud_specification)}</p>
          <p><strong>Xuất xứ:</strong> ${escapeHtml(lot.nursery_name)} (${escapeHtml(lot.hamlet_area)})</p>
          <p><strong>Điểm uy tín nhà vườn:</strong> ${(lot.fulfillment_score_bps / 100).toFixed(1)}%</p>
        </section>
        <section class="pricing">
          <p class="price"><strong>${lot.unit_price_vnd.toLocaleString('vi-VN')} VND</strong> / ${escapeHtml(lot.unit)}</p>
          <p class="moq">Tối thiểu (MOQ): <strong>${lot.moq_units}</strong> ${escapeHtml(lot.unit)} • Còn lại: <strong>${lot.available_units}</strong> ${escapeHtml(lot.unit)}</p>
          <p class="deposit">Cọc yêu cầu: <strong>${depositPct}%</strong> • Ngày xuất: <strong>${escapeHtml(lot.cut_or_ship_date)}</strong></p>
          <p class="revision"><small>Revision: <code>${escapeHtml(lot.revision)}</code></small></p>
        </section>
      </article>`;
    })
    .join('\n');

  const lotRows = lots
    .map(
      (lot) => `          <tr>
            <td><code>${escapeHtml(lot.lot_code)}</code></td>
            <td><strong>${escapeHtml(lot.name)}</strong><br><small>${escapeHtml(lot.species)}</small></td>
            <td>${escapeHtml(lot.grade)}</td>
            <td>Ø${lot.pot_diameter_cm} / C${lot.height_cm} / T${lot.canopy_cm}</td>
            <td>${lot.unit_price_vnd.toLocaleString('vi-VN')} đ</td>
            <td>${lot.moq_units} ${escapeHtml(lot.unit)}</td>
            <td>${lot.available_units}</td>
            <td>${escapeHtml(lot.cut_or_ship_date)}</td>
            <td>${escapeHtml(lot.nursery_name)}</td>
            <td><code>${escapeHtml(lot.revision)}</code></td>
          </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sa Đéc Flow — Danh mục Sỉ Hoa Kiểng Sa Đéc → TP.HCM</title>
    <meta name="description" content="Danh mục sỉ hoa kiểng Sa Đéc kết nối trực tiếp nhà vườn với vựa hoa TP.HCM. Bảo chứng cọc VietQR Escrow 0đ ứng vốn, kiểm định chất lượng minh bạch." />
    <link rel="canonical" href="${cleanOrigin}/discover" />
    <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2).replace(/</g, '\\u003c')}
    </script>
    <style>
      :root {
        --bg: #fafaf9;
        --card-bg: #ffffff;
        --text: #1c1917;
        --text-muted: #57534e;
        --border: #d6d3d1;
        --accent: #15803d;
        --accent-light: #dcfce7;
        --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0c0a09;
          --card-bg: #1c1917;
          --text: #f5f5f4;
          --text-muted: #a8a29e;
          --border: #292524;
          --accent: #22c55e;
          --accent-light: #14532d;
        }
      }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.5;
        padding: 1rem;
      }
      header.page-header {
        max-width: 1200px;
        margin: 0 auto 2rem;
        border-bottom: 2px solid var(--accent);
        padding-bottom: 1rem;
      }
      h1 { margin: 0 0 0.5rem; font-size: 1.75rem; color: var(--accent); }
      p.subtitle { margin: 0; color: var(--text-muted); font-size: 1rem; }
      nav.quick-links { margin-top: 1rem; font-size: 0.9rem; }
      nav.quick-links a { color: var(--accent); margin-right: 1rem; text-decoration: underline; }
      main { max-width: 1200px; margin: 0 auto; }
      .catalog-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 1.25rem;
        margin-bottom: 2rem;
      }
      .lot-card {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 1.25rem;
        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      }
      .badge {
        display: inline-block;
        padding: 0.2rem 0.6rem;
        font-size: 0.75rem;
        font-weight: bold;
        border-radius: 4px;
        margin-right: 0.5rem;
      }
      .badge-weekly { background: #e0f2fe; color: #0369a1; }
      .badge-seasonal { background: #fef3c7; color: #92400e; }
      .sku { font-size: 0.8rem; color: var(--text-muted); }
      h3 { margin: 0.5rem 0 0.25rem; font-size: 1.2rem; }
      p.species { margin: 0 0 0.75rem; color: var(--text-muted); font-size: 0.9rem; }
      .specs { font-size: 0.9rem; border-top: 1px solid var(--border); padding-top: 0.5rem; }
      .specs p { margin: 0.25rem 0; }
      .pricing { border-top: 1px dashed var(--border); margin-top: 0.75rem; padding-top: 0.5rem; }
      .pricing .price { font-size: 1.2rem; color: var(--accent); margin: 0.25rem 0; }
      .pricing .moq, .pricing .deposit { margin: 0.25rem 0; font-size: 0.9rem; }
      code { font-family: var(--font-mono); font-size: 0.85em; background: rgba(125,125,125,0.1); padding: 0.1em 0.3em; border-radius: 3px; }
      section.catalog-table-wrapper { margin: 3rem 0; overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 0.9rem; text-align: left; }
      th, td { border: 1px solid var(--border); padding: 0.6rem; }
      th { background: var(--card-bg); }
      section.glossary { margin: 3rem 0; background: var(--card-bg); padding: 1.5rem; border: 1px solid var(--border); border-radius: 8px; }
      dt { font-weight: bold; color: var(--accent); margin-top: 0.75rem; }
      dd { margin-left: 1rem; color: var(--text-muted); }
      footer { border-top: 1px solid var(--border); padding: 2rem 0; text-align: center; color: var(--text-muted); font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <header class="page-header">
      <h1>Sa Đéc Flow — Sàn Giao Dịch Hoa Kiểng B2B</h1>
      <p class="subtitle">Kết nối nhà vườn Làng hoa Sa Đéc với vựa kiểng TP.HCM • Bảo chứng VietQR Escrow 0đ Ứng Vốn</p>
      <nav class="quick-links">
        <a href="${cleanOrigin}/llms.txt">llms.txt</a>
        <a href="${cleanOrigin}/llms-full.txt">llms-full.txt</a>
        <a href="${cleanOrigin}/docs.md">docs.md</a>
        <a href="${cleanOrigin}/api/schema">api/schema</a>
        <a href="${cleanOrigin}/api/public/catalog">api/public/catalog</a>
      </nav>
    </header>

    <main>
      <section class="glossary">
        <h2>Định Vị Cốt Lõi: "Bộ đôi Chắc tiền &amp; Giá gốc"</h2>
        <p><strong>1. Với Nhà Vườn Sa Đéc:</strong> Cầm chắc 30–50% tiền cọc tươi trong tài khoản bảo chứng VietQR Escrow trước khi bứng chậu; giao đạt chuẩn tại Hub Sa Đéc là giải ngân ngay sáng hôm sau — không lo thương lái ép giá hay bùng cọc ngày 29–30 Tết.</p>
        <p><strong>2. Với Shop Hoa TP.HCM:</strong> Mua thẳng giá gốc tại vườn (sàn chỉ thu phí dịch vụ minh bạch 2–5%, 0đ kê giá trung gian); hoàn cọc 100% nếu lô hoa giao sai quy cách nụ, tán, chiều cao.</p>
        <table>
          <thead>
            <tr>
              <th>Tiêu chí đối chiếu</th>
              <th>Thương lái truyền thống</th>
              <th>Sa Đéc Flow (VietQR Escrow)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Giá nhập sỉ</strong></td>
              <td>Đội giá 20%–35% qua nhiều tầng trung gian</td>
              <td><strong>Giá gốc nhà vườn</strong> + Phí sàn 2%–5% (0đ kê giá)</td>
            </tr>
            <tr>
              <td><strong>Bảo chứng tiền cọc</strong></td>
              <td>Cọc miệng / chuyển khoản cá nhân rủi ro cao</td>
              <td><strong>VietQR Escrow (30%–50%)</strong>, sàn ứng vốn 0 VND</td>
            </tr>
            <tr>
              <td><strong>Kiểm định chất lượng</strong></td>
              <td>Ảnh chụp tự phát, dễ bị tráo chậu hoặc nụ điếc</td>
              <td><strong>Kiểm định kép 2 chặng</strong> kèm tem QR HMAC-SHA256 niêm phong</td>
            </tr>
            <tr>
              <td><strong>Rủi ro sai quy cách</strong></td>
              <td>Chủ shop tự chịu thiệt hại</td>
              <td><strong>Hoàn cọc 100%</strong> từ sổ cái Escrow nếu lỗi do nhà vườn</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>Danh Sách Lô Hoa Kiểng Đang Mở Bán</h2>
        <div class="catalog-grid">
${lotArticles}
        </div>
      </section>

      <section class="catalog-table-wrapper">
        <h2>Bảng Đối Soát Tổng Hợp Cho Agent & Quản Trị</h2>
        <table>
          <thead>
            <tr>
              <th>Mã Lô</th>
              <th>Tên Hoa Kiểng</th>
              <th>Hạng</th>
              <th>Quy Cách (Ø/C/T)</th>
              <th>Giá Sỉ</th>
              <th>MOQ</th>
              <th>Tồn Khả Dụng</th>
              <th>Ngày Xuất</th>
              <th>Nhà Vườn</th>
              <th>Revision</th>
            </tr>
          </thead>
          <tbody>
${lotRows}
          </tbody>
        </table>
      </section>

      <section class="glossary">
        <h2>Thuật Ngữ & Bất Biến Vận Hành</h2>
        <dl>
          <dt>VietQR Escrow 0đ Ứng Vốn (Zero Platform Outlay)</dt>
          <dd>Toàn bộ tiền cọc của người mua được khóa trong tài khoản bảo chứng. Sàn Sa Đéc Flow không bao giờ ứng vốn lưu động (platformOutlayVnd === 0).</dd>
          <dt>Revision Token (Kiểm Soát Xung Đột Lạc Quan)</dt>
          <dd>Mã tất định dạng <code>id:u{units}:{status}:{timestamp}</code> dùng để đảm bảo Agent hoặc người mua không đặt nhầm lô hàng vừa thay đổi tồn kho.</dd>
          <dt>Dual-Surface Architecture</dt>
          <dd>Mô hình phục vụ song song: Giao diện trực quan Biophilic Bento cho người dùng và Giao thức WebMCP/AEO/GEO cho AI Agent.</dd>
        </dl>
      </section>
    </main>

    <footer>
      <p>Sa Đéc Flow © 2026. Làng hoa Sa Đéc, Đồng Tháp → TP.HCM. Zero Working Capital Outlay Invariant.</p>
    </footer>
  </body>
</html>`;
}

/**
 * Builds JSON Schema (Draft 2020-12) for the 4 WebMCP tools.
 * Top-level keys are the 4 tool names: listSupplyLots, quoteBooking, proposeBooking, verifyQrToken.
 */
export function buildAgentJsonSchemas(): Record<string, unknown> {
  const schemaDraft = 'https://json-schema.org/draft/2020-12/schema';

  return {
    listSupplyLots: {
      $schema: schemaDraft,
      title: 'listSupplyLots',
      description:
        'Liệt kê danh sách các lô hoa kiểng sỉ đang mở bán (PUBLISHED hoặc SOLD_OUT) kèm revision và báo giá mẫu.',
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['WEEKLY_CATALOG', 'SEASONAL_PREORDER'],
          description:
            'Bộ lọc theo chế độ cung ứng: WEEKLY_CATALOG (hàng nhập tuần) hoặc SEASONAL_PREORDER (sổ đặt trước vụ Tết).',
        },
      },
    },
    quoteBooking: {
      $schema: schemaDraft,
      title: 'quoteBooking',
      description:
        'Tính toán số tiền đặt cọc và phí nền tảng trong phạm vi số nguyên VND an toàn.',
      type: 'object',
      additionalProperties: false,
      required: ['quantity', 'unitPriceVnd', 'depositRateBps', 'platformFeeBps'],
      properties: {
        quantity: {
          type: 'integer',
          minimum: 1,
          description: 'Số lượng đặt (phải là số nguyên dương).',
        },
        unitPriceVnd: {
          type: 'integer',
          minimum: 1,
          description: 'Đơn giá xuất vườn (số nguyên VND).',
        },
        depositRateBps: {
          type: 'integer',
          minimum: 3000,
          maximum: 5000,
          description: 'Tỷ lệ cọc theo basis points (3000..5000 tương ứng 30%..50%).',
        },
        platformFeeBps: {
          type: 'integer',
          minimum: 200,
          maximum: 500,
          description: 'Tỷ lệ phí sàn theo basis points (200..500 tương ứng 2%..5%).',
        },
      },
    },
    proposeBooking: {
      $schema: schemaDraft,
      title: 'proposeBooking',
      description:
        'Tạo đề xuất đơn đặt giữ lên Agent Proposal HUD để con người xác nhận trước khi tạo mã VietQR (Zero Auto-Spend).',
      type: 'object',
      additionalProperties: false,
      required: [
        'lotId',
        'quantity',
        'expectedRevision',
        'buyerShopName',
        'buyerContactPhone',
        'destinationMarket',
      ],
      properties: {
        lotId: {
          type: 'string',
          description: 'ID định danh duy nhất của lô hoa kiểng.',
        },
        quantity: {
          type: 'integer',
          minimum: 1,
          description: 'Số lượng đặt mua.',
        },
        expectedRevision: {
          type: 'string',
          description:
            'Mã revision hiện tại của lô để chống xung đột đặt trùng (Optimistic Concurrency).',
        },
        buyerShopName: {
          type: 'string',
          minLength: 2,
          description: 'Tên cửa hàng hoặc vựa hoa nhận hàng tại TP.HCM.',
        },
        buyerContactPhone: {
          type: 'string',
          pattern: '^0[0-9]{9,10}$',
          description: 'Số điện thoại liên hệ nhận hàng.',
        },
        destinationMarket: {
          type: 'string',
          description: 'Điểm giao hàng tại TP.HCM (VD: Chợ Hồ Thị Kỷ, Chợ Đầm Sen).',
        },
        note: {
          type: 'string',
          description: 'Ghi chú thêm về thời gian nhận hoặc yêu cầu đóng gói.',
        },
      },
    },
    verifyQrToken: {
      $schema: schemaDraft,
      title: 'verifyQrToken',
      description:
        'Xác thực tính hợp lệ của mã QR Token HMAC-SHA256 gắn trên lô hàng hoặc sọt kiện vận chuyển.',
      type: 'object',
      additionalProperties: false,
      required: ['token'],
      properties: {
        token: {
          type: 'string',
          description: 'Chuỗi mã QR bắt đầu bằng tiền tố SDECQR.',
        },
      },
    },
  };
}

/**
 * Representative sample B2B supply lots (Cúc mâm xôi, Mai vàng, Kiểng lá, Cây nội thất)
 * projected through `toPublicLotProjection` for static discovery assets and fallback display.
 */
export const SAMPLE_LOTS: readonly PublicLotProjection[] = [
  toPublicLotProjection({
    id: 'lot-tet-01',
    lot_code: 'SDEC-LOT-TET01',
    nursery_workspace_id: 'ws-demo-a',
    name: 'Cúc mâm xôi đại Hàn Quốc (Sổ đặt trước Tết 2027)',
    mode: 'SEASONAL_PREORDER',
    species: 'Chrysanthemum morifolium',
    grade: 'A+',
    pot_diameter_cm: 40,
    height_cm: 75,
    canopy_cm: 100,
    bud_specification: 'Tán tròn mâm xôi 100cm, nụ kim đều 100%, nở rộ đúng 27-29 Tết',
    media_proof_url: 'https://images.example.test/sadec/lot-tet-01.jpg',
    unit: 'cặp',
    unit_price_vnd: 320000,
    deposit_rate_bps: 4000,
    moq_units: 25,
    total_units: 300,
    available_units: 240,
    cut_or_ship_date: '2027-01-28',
    qr_lot_token: 'SDEC-QR-LOT-TET01.demo-hmac-signature',
    status: 'PUBLISHED',
    created_at: '2026-10-23T02:00:00.000Z',
    updated_at: '2026-10-23T02:00:00.000Z',
    nursery_name: 'Vườn Hoa Tư Kiểng (Tân Quy Đông)',
    hamlet_area: 'Tân Quy Đông, Sa Đéc',
    fulfillment_score_bps: 9850,
  }),
  toPublicLotProjection({
    id: 'lot-tet-02',
    lot_code: 'SDEC-LOT-TET02',
    nursery_workspace_id: 'ws-demo-b',
    name: 'Mai vàng giảo Thủ Đức ghép 3 mùa (Đặt trước Tết)',
    mode: 'SEASONAL_PREORDER',
    species: 'Ochna integerrima',
    grade: 'A',
    pot_diameter_cm: 45,
    height_cm: 130,
    canopy_cm: 95,
    bud_specification: 'Hoành gốc 18-22cm, bông 8-12 cánh, mắt nụ dày đã xử lý phân hóa mầm hoa',
    media_proof_url: 'https://images.example.test/sadec/lot-tet-02.jpg',
    unit: 'chậu',
    unit_price_vnd: 850000,
    deposit_rate_bps: 4500,
    moq_units: 10,
    total_units: 100,
    available_units: 80,
    cut_or_ship_date: '2027-01-30',
    qr_lot_token: 'SDEC-QR-LOT-TET02.demo-hmac-signature',
    status: 'PUBLISHED',
    created_at: '2026-10-23T02:00:00.000Z',
    updated_at: '2026-10-23T02:00:00.000Z',
    nursery_name: 'Vườn Mai Ba Hoàng (Tân Khánh Đông)',
    hamlet_area: 'Tân Khánh Đông, Sa Đéc',
    fulfillment_score_bps: 9720,
  }),
  toPublicLotProjection({
    id: 'lot-w-01',
    lot_code: 'SDEC-LOT-W01',
    nursery_workspace_id: 'ws-demo-c',
    name: 'Monstera Thai Constellation (Kiểng lá xuất tuần)',
    mode: 'WEEKLY_CATALOG',
    species: 'Monstera deliciosa',
    grade: 'A',
    pot_diameter_cm: 25,
    height_cm: 55,
    canopy_cm: 50,
    bud_specification: '4-5 lá xẻ đều, mảng var kem rõ >= 30%, rễ khỏe ấm chậu',
    media_proof_url: 'https://images.example.test/sadec/lot-w-01.jpg',
    unit: 'chậu',
    unit_price_vnd: 220000,
    deposit_rate_bps: 3000,
    moq_units: 20,
    total_units: 120,
    available_units: 90,
    cut_or_ship_date: '2026-10-28',
    qr_lot_token: 'SDEC-QR-LOT-W01.demo-hmac-signature',
    status: 'PUBLISHED',
    created_at: '2026-10-23T02:00:00.000Z',
    updated_at: '2026-10-23T02:00:00.000Z',
    nursery_name: 'Vườn Kiểng Lá Út Mười (Sa Nhiên)',
    hamlet_area: 'Sa Nhiên, Sa Đéc',
    fulfillment_score_bps: 9910,
  }),
  toPublicLotProjection({
    id: 'lot-w-02',
    lot_code: 'SDEC-LOT-W02',
    nursery_workspace_id: 'ws-demo-a',
    name: 'Cau vàng nội thất chậu sứ (Lô hàng tuần)',
    mode: 'WEEKLY_CATALOG',
    species: 'Chrysalidocarpus lutescens',
    grade: 'A',
    pot_diameter_cm: 30,
    height_cm: 110,
    canopy_cm: 70,
    bud_specification: 'Bụi 7-9 thân vàng óng, lá xanh mướt không cháy đầu lá',
    media_proof_url: 'https://images.example.test/sadec/lot-w-02.jpg',
    unit: 'chậu',
    unit_price_vnd: 180000,
    deposit_rate_bps: 3000,
    moq_units: 15,
    total_units: 150,
    available_units: 150,
    cut_or_ship_date: '2026-10-29',
    qr_lot_token: 'SDEC-QR-LOT-W02.demo-hmac-signature',
    status: 'PUBLISHED',
    created_at: '2026-10-23T02:00:00.000Z',
    updated_at: '2026-10-23T02:00:00.000Z',
    nursery_name: 'Vườn Hoa Tư Kiểng (Tân Quy Đông)',
    hamlet_area: 'Tân Quy Đông, Sa Đéc',
    fulfillment_score_bps: 9850,
  }),
];

