import { useMemo, useState } from 'react';
import {
  calculateBookingQuote,
  type BookingQuoteResult,
} from '../../domain/escrow-ledger.ts';
import { assertSafeVnd, multiplyByBasisPoints } from '../../domain/money.ts';
import { formatVnd } from '../format.ts';

export interface MarketingLandingProps {
  onOpenMarketplace: () => void;
  onOpenGtmHub: () => void;
}

export interface MiddlemanSavingsComparisonInput {
  quantity: number;
  unitPriceVnd: number;
  depositRateBps: number;
  platformFeeBps: number;
  middlemanMarkupBps: number;
}

export interface MiddlemanSavingsComparisonResult {
  quote: BookingQuoteResult;
  middlemanMarkupVnd: number;
  middlemanTotalVnd: number;
  netSavingsVnd: number;
  platformOutlayVnd: 0;
}

interface PresetLotOption {
  id: string;
  label: string;
  unitPriceVnd: number;
  defaultQuantity: number;
  defaultDepositRateBps: number;
  unitLabel: string;
}

const DEFAULT_PLATFORM_FEE_BPS = 300;

const PRESET_LOTS: readonly PresetLotOption[] = [
  {
    id: 'cuc-mam-xoi-han-quoc',
    label: 'Cúc Mâm Xôi Đại Hàn Quốc (300.000đ/cặp)',
    unitPriceVnd: 300_000,
    defaultQuantity: 50,
    defaultDepositRateBps: 4000,
    unitLabel: 'cặp',
  },
  {
    id: 'monstera-thai-constellation',
    label: 'Monstera Thai Constellation (220.000đ/chậu)',
    unitPriceVnd: 220_000,
    defaultQuantity: 30,
    defaultDepositRateBps: 3000,
    unitLabel: 'chậu',
  },
  {
    id: 'cau-vang-noi-that',
    label: 'Cau Vàng Nội Thất Chậu Sứ (180.000đ/chậu)',
    unitPriceVnd: 180_000,
    defaultQuantity: 40,
    defaultDepositRateBps: 3000,
    unitLabel: 'chậu',
  },
  {
    id: 'mai-vang-giao-thu-duc',
    label: 'Mai Vàng Giảo Thủ Đức (450.000đ/gốc)',
    unitPriceVnd: 450_000,
    defaultQuantity: 20,
    defaultDepositRateBps: 5000,
    unitLabel: 'gốc',
  },
];

interface ComparisonRow {
  criterion: string;
  traditionalMiddleman: string;
  saDecFlow: string;
}

const COMPARISON_ROWS: readonly ComparisonRow[] = [
  {
    criterion: '1. Giá mua sỉ & Phí trung gian',
    traditionalMiddleman:
      'Đội giá 20%–35% qua 3 tầng cò lái và vựa trung gian, người mua không biết giá gốc tại bờ líp.',
    saDecFlow:
      'Giá gốc nhà vườn niêm yết công khai + phí sàn minh bạch 2%–5% (chuẩn 3%), cam kết 0đ kê giá.',
  },
  {
    criterion: '2. Bảo vệ tiền cọc & Thanh toán',
    traditionalMiddleman:
      'Cọc miệng hoặc giấy viết tay cá nhân, dễ bị bùng cọc hoặc bán chồng lô vào ngày 28–29 Tết.',
    saDecFlow:
      'Khóa cọc 30%–50% qua VietQR Escrow EMVCo chính danh, sàn ứng vốn 0đ (platformOutlayVnd === 0).',
  },
  {
    criterion: '3. Kiểm định quy cách nụ & tán',
    traditionalMiddleman:
      'Mua mù qua ảnh cũ trên mạng, dễ bị tráo hàng loại C, nụ điếc hoặc tán thiếu kích thước khi giao đêm.',
    saDecFlow:
      'Kiểm định 3 chốt chặn (bờ líp, Hub Sa Đéc, sạp TP.HCM), dán tem niêm phong QR HMAC-SHA256 tại Hub Sa Đéc.',
  },
  {
    criterion: '4. Vận chuyển Sa Đéc → TP.HCM',
    traditionalMiddleman:
      'Nhồi nhét xe tải tạp dọc quốc lộ, quăng quật làm dập lá, gãy cành, bể bầu từ 10%–15%.',
    saDecFlow:
      'Ghép xe lồng sắt phân tầng Cross-Docking chạy xuyên đêm về chợ đầu mối và sạp hoa, tỷ lệ dập < 1%.',
  },
  {
    criterion: '5. Xử lý rủi ro hoa nở sớm / sai nụ',
    traditionalMiddleman:
      'Người mua tự chịu lỗ hoặc cự cãi tay đôi với tài xế, nhà vườn đổ lỗi cho nhà xe lúc 3h sáng.',
    saDecFlow:
      'Khấu trừ tự động từng chậu lỗi trên sổ cái hoặc hoàn cọc 100% từ két Escrow nếu sai cam kết mắt nụ.',
  },
];

/**
 * Pure domain calculator comparing traditional middleman markup against Sa Đéc Flow direct B2B booking.
 * All arithmetic uses exact integer VND and basis points.
 */
export function computeMiddlemanSavingsComparison(
  input: MiddlemanSavingsComparisonInput,
): MiddlemanSavingsComparisonResult {
  const quote = calculateBookingQuote({
    quantity: input.quantity,
    unitPriceVnd: input.unitPriceVnd,
    depositRateBps: input.depositRateBps,
    platformFeeBps: input.platformFeeBps,
  });

  const middlemanMarkupVnd = multiplyByBasisPoints(
    quote.grossTotalVnd,
    input.middlemanMarkupBps,
  );
  const middlemanTotalVnd = assertSafeVnd(
    quote.grossTotalVnd + middlemanMarkupVnd,
  );
  const netSavingsVnd = assertSafeVnd(
    middlemanTotalVnd - quote.estimatedBuyerTotalVnd,
  );

  return {
    quote,
    middlemanMarkupVnd,
    middlemanTotalVnd,
    netSavingsVnd,
    platformOutlayVnd: 0,
  };
}

export function MarketingLanding({
  onOpenMarketplace,
  onOpenGtmHub,
}: MarketingLandingProps) {
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    'cuc-mam-xoi-han-quoc',
  );
  const [quantity, setQuantity] = useState<number>(50);
  const [unitPriceVnd, setUnitPriceVnd] = useState<number>(300_000);
  const [depositRateBps, setDepositRateBps] = useState<number>(4000);
  const [middlemanMarkupBps, setMiddlemanMarkupBps] = useState<number>(2500);

  const handlePresetChange = (presetId: string) => {
    setSelectedPresetId(presetId);
    const found = PRESET_LOTS.find((item) => item.id === presetId);
    if (found) {
      setUnitPriceVnd(found.unitPriceVnd);
      setQuantity(found.defaultQuantity);
      setDepositRateBps(found.defaultDepositRateBps);
    }
  };

  const safeQuantity =
    Number.isInteger(quantity) && quantity >= 1 ? Math.min(quantity, 2000) : 1;
  const safeUnitPriceVnd =
    Number.isInteger(unitPriceVnd) && unitPriceVnd >= 1000
      ? unitPriceVnd
      : 10_000;

  const comparison = useMemo(
    () =>
      computeMiddlemanSavingsComparison({
        quantity: safeQuantity,
        unitPriceVnd: safeUnitPriceVnd,
        depositRateBps,
        platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
        middlemanMarkupBps,
      }),
    [safeQuantity, safeUnitPriceVnd, depositRateBps, middlemanMarkupBps],
  );

  return (
    <div className="bento-grid">
      {/* 1. Hero Section */}
      <section
        className="panel bento-full marketing-hero"
        aria-labelledby="marketing-hero-title"
      >
        <div className="marketing-hero__eyebrow">
          🌿 Sàn Giao Dịch Hoa Kiểng B2B Đầu Tiên Tại Việt Nam
        </div>
        <h2 id="marketing-hero-title" className="marketing-hero__title">
          Bộ Đôi Chắc Tiền &amp; Giá Gốc — Kết Nối Thẳng Nhà Vườn Sa Đéc → Shop
          Hoa TP.HCM
        </h2>
        <p className="marketing-hero__lead">
          Nhà vườn Tân Quy Đông, Sa Nhiên, Cai Dao cầm chắc cọc tươi 30–50% qua
          VietQR Escrow trước khi bứng chậu; Chủ shop hoa TP.HCM (Hồ Thị Kỷ, Đầm
          Sen, Thủ Đức) mua thẳng giá gốc tại bờ líp (0đ kê giá trung gian, phí
          sàn minh bạch 2–5%), kiểm định 3 chốt chặn, hoàn cọc 100% nếu sai quy
          cách nụ/tán.
        </p>

        <div className="marketing-pillars">
          <article className="marketing-pillar-card">
            <h3 className="marketing-pillar-card__title">
              🛡️ Cọc Tươi Bảo Chứng 30–50%
            </h3>
            <p className="marketing-pillar-card__desc">
              Khóa VietQR Escrow EMVCo chính danh trước khi ra líp vô bội, không
              sợ thương lái bùng cọc 29 Tết, sàn ứng vốn 0đ (
              <code>platformOutlayVnd === 0</code>).
            </p>
          </article>

          <article className="marketing-pillar-card">
            <h3 className="marketing-pillar-card__title">
              💎 Giá Gốc Tận Vườn — 0đ Kê Giá
            </h3>
            <p className="marketing-pillar-card__desc">
              Cắt bỏ 3 tầng cò vựa đội giá 20–35%, niêm yết số nguyên VND minh
              bạch kèm khóa phiên bản báo giá bất biến (<code>revision</code>).
            </p>
          </article>

          <article className="marketing-pillar-card">
            <h3 className="marketing-pillar-card__title">
              🔄 Kiểm Định Kép &amp; Hoàn Cọc 100%
            </h3>
            <p className="marketing-pillar-card__desc">
              Niêm phong QR HMAC-SHA256 tại Hub Sa Đéc, ghép xe lồng sắt
              Cross-Docking xuyên đêm, hoàn cọc 100% nếu giao sai cam kết nụ.
            </p>
          </article>
        </div>

        <div className="action-cluster margin-top-16">
          <button
            type="button"
            className="btn"
            onClick={onOpenMarketplace}
          >
            🛒 Vào Chợ Sỉ Đặt Lô Ngay
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onOpenGtmHub}
          >
            🚀 Mở Bộ Công Cụ Tác Chiến CMO &amp; SDR
          </button>
        </div>
      </section>

      {/* 2. Interactive ROI & VietQR Escrow Calculator */}
      <section
        className="panel bento-full"
        aria-labelledby="roi-calculator-title"
      >
        <h3 id="roi-calculator-title" className="panel__title">
          🧮 Máy Tính Tiết Kiệm Giá Gốc &amp; Tiền Cọc Bảo Chứng VietQR Escrow
        </h3>
        <p className="field__hint margin-bottom-16">
          Chọn lô hoa mẫu hoặc nhập số lượng thực tế để đối chiếu số tiền giữ lại
          cho shop khi mua thẳng từ bờ líp Sa Đéc thay vì qua thương lái trung
          gian.
        </p>

        <div className="roi-calc__grid">
          <div className="field">
            <label className="field__label" htmlFor="roi-preset-lot">
              Lô hoa kiểng mẫu tại vườn
            </label>
            <select
              id="roi-preset-lot"
              value={selectedPresetId}
              onChange={(e) => handlePresetChange(e.target.value)}
            >
              {PRESET_LOTS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="roi-quantity">
              Số lượng đặt sỉ (1 – 2.000)
            </label>
            <input
              id="roi-quantity"
              type="number"
              min={1}
              max={2000}
              step={1}
              value={quantity}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                setQuantity(Number.isNaN(parsed) ? 1 : Math.max(1, Math.min(2000, parsed)));
              }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="roi-unit-price">
              Đơn giá gốc tại vườn (VND)
            </label>
            <input
              id="roi-unit-price"
              type="number"
              min={10000}
              step={10000}
              value={unitPriceVnd}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                setUnitPriceVnd(Number.isNaN(parsed) ? 10_000 : Math.max(10_000, parsed));
              }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="roi-deposit-rate">
              Tỷ lệ cọc bảo chứng Escrow
            </label>
            <select
              id="roi-deposit-rate"
              value={depositRateBps}
              onChange={(e) => setDepositRateBps(Number.parseInt(e.target.value, 10))}
            >
              <option value={3000}>30% (Hàng tuần)</option>
              <option value={4000}>40% Chuẩn</option>
              <option value={5000}>50% Vụ Tết</option>
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="roi-middleman-markup">
              Mức kê giá cò lái truyền thống
            </label>
            <select
              id="roi-middleman-markup"
              value={middlemanMarkupBps}
              onChange={(e) =>
                setMiddlemanMarkupBps(Number.parseInt(e.target.value, 10))
              }
            >
              <option value={2000}>20%</option>
              <option value={2500}>25% Phổ biến</option>
              <option value={3000}>30%</option>
              <option value={3500}>35% Cao điểm Tết</option>
            </select>
          </div>
        </div>

        <div className="roi-calc__summary">
          <div className="roi-card roi-card--danger">
            <span className="roi-card__label">
              Mua Qua Thương Lái (Bị kê giá)
            </span>
            <strong className="roi-card__value roi-card__value--danger">
              {formatVnd(comparison.middlemanTotalVnd)} đ
            </strong>
            <span className="field__hint">
              Gồm {formatVnd(comparison.middlemanMarkupVnd)} đ tiền cò vựa ăn
              chênh lệch
            </span>
          </div>

          <div className="roi-card">
            <span className="roi-card__label">
              Mua Thẳng Trên Sa Đéc Flow
            </span>
            <strong className="roi-card__value">
              {formatVnd(comparison.quote.estimatedBuyerTotalVnd)} đ
            </strong>
            <span className="field__hint">
              Giá gốc vườn {formatVnd(comparison.quote.grossTotalVnd)} đ + Phí
              sàn 3% {formatVnd(comparison.quote.platformFeeVnd)} đ
            </span>
          </div>

          <div className="roi-card roi-card--highlight">
            <span className="roi-card__label">
              Tiết Kiệm Ròng Giữ Lại Cho Shop
            </span>
            <strong className="roi-card__value roi-card__value--primary">
              {formatVnd(comparison.netSavingsVnd)} đ
            </strong>
            <span className="field__hint">
              0đ kê giá • Sàn ứng vốn {comparison.platformOutlayVnd} VND
            </span>
          </div>

          <div className="roi-card">
            <span className="roi-card__label">
              Cọc Bảo Chứng VietQR Escrow Cần Đóng
            </span>
            <strong className="roi-card__value roi-card__value--primary">
              {formatVnd(comparison.quote.depositRequiredVnd)} đ
            </strong>
            <span className="field__hint">
              Giữ trong két Escrow • Hoàn 100% nếu sai quy cách nụ
            </span>
          </div>
        </div>
      </section>

      {/* 3. Direct Comparison Table */}
      <section
        className="panel bento-full"
        aria-labelledby="comparison-table-title"
      >
        <h3 id="comparison-table-title" className="panel__title">
          ⚖️ Đối Soát Trực Diện: Thương Lái Truyền Thống vs. Sa Đéc Flow
        </h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Tiêu chí giao thương</th>
                <th scope="col">Mua qua Thương Lái / Vựa Trung Gian</th>
                <th scope="col">Đặt trực tiếp trên Sa Đéc Flow</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.criterion}>
                  <td className="text-bold">{row.criterion}</td>
                  <td>{row.traditionalMiddleman}</td>
                  <td className="text-ink text-bold">{row.saDecFlow}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
