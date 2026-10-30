import { useState, useEffect, useCallback } from 'react';
import {
  ApiError,
  fetchB2bLots,
  createB2bBooking,
  createB2bLot,
  newIdempotencyKey,
  type SupplyLotView,
  type VietQrPayloadView,
} from '../api.ts';
import {
  clearStagedProposal,
  getStagedProposal,
  subscribeProposals,
  type BookingProposal,
} from '../agent-bridge.ts';
import { calculateBookingQuote } from '../../domain/escrow-ledger.ts';
import {
  buildLotJsonLd,
  computeLotRevision,
  type PublicLotProjection,
} from '../../domain/aeo-projection.ts';
import { formatVnd } from '../format.ts';
import { EmptyState, ErrorState, LoadingState, SuccessState } from './states.tsx';
import { ProvenanceSvg } from './provenance-svg.tsx';

const DEFAULT_PLATFORM_FEE_BPS = 300;
const FALLBACK_TIMESTAMP = '2026-10-23T02:00:00.000Z';

function formatVndCurrency(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(amount)} ₫`;
}

function resolveLotRevision(lot: SupplyLotView): string {
  if (typeof lot.revision === 'string' && lot.revision.trim() !== '') {
    return lot.revision;
  }
  return computeLotRevision({
    id: lot.id,
    available_units: lot.available_units,
    status: lot.status,
    updated_at: lot.updated_at ?? lot.created_at ?? FALLBACK_TIMESTAMP,
  });
}

function toPublicProjection(lot: SupplyLotView): PublicLotProjection {
  const revision = resolveLotRevision(lot);
  const sample_moq_quote = calculateBookingQuote({
    quantity: lot.moq_units > 0 ? lot.moq_units : 1,
    unitPriceVnd: lot.unit_price_vnd,
    depositRateBps: lot.deposit_rate_bps,
    platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
  });

  return {
    id: lot.id,
    lot_code: lot.lot_code,
    name: lot.name,
    mode: lot.mode,
    species: lot.species,
    grade: lot.grade,
    pot_diameter_cm: lot.pot_diameter_cm,
    height_cm: lot.height_cm,
    canopy_cm: lot.canopy_cm,
    bud_specification: lot.bud_specification,
    unit: lot.unit,
    unit_price_vnd: lot.unit_price_vnd,
    deposit_rate_bps: lot.deposit_rate_bps,
    moq_units: lot.moq_units,
    total_units: lot.total_units,
    available_units: lot.available_units,
    cut_or_ship_date: lot.cut_or_ship_date,
    status: lot.status,
    nursery_name: lot.nursery_name ?? 'Vườn Sa Đéc',
    hamlet_area: lot.hamlet_area ?? 'Tân Quy Đông',
    fulfillment_score_bps: lot.fulfillment_score_bps ?? 9800,
    revision,
    sample_moq_quote,
  };
}

export interface AgentProposalHudProps {
  proposal: BookingProposal | null;
  onConfirm: (proposal: BookingProposal) => void;
  onDismiss: () => void;
}

export function AgentProposalHud({
  proposal,
  onConfirm,
  onDismiss,
}: AgentProposalHudProps) {
  if (!proposal) {
    return null;
  }

  const quote = calculateBookingQuote({
    quantity: proposal.quantity,
    unitPriceVnd: proposal.unitPriceVnd,
    depositRateBps: proposal.depositRateBps,
    platformFeeBps: proposal.platformFeeBps,
  });

  return (
    <section
      className="agent-hud"
      aria-label="Đề xuất đặt giữ từ AI Agent Co-Pilot"
    >
      <div className="agent-hud__header">
        <div>
          <span className="role badge--spaced-right">
            🤖 Agent Co-Pilot Proposal HUD
          </span>
          <strong className="lot-card__title">
            {proposal.lotName} ({proposal.quantity} {proposal.unit})
          </strong>
        </div>
        <span className="role text-mono">
          expectedRevision: {proposal.expectedRevision}
        </span>
      </div>

      <p className="field__hint agent-hud__lead">
        <strong>Sàn ứng vốn 0đ</strong> — Đề xuất chỉ có hiệu lực khi người dùng trực tiếp xác nhận tạo mã VietQR Escrow (Zero Auto-Spend).
      </p>

      <div className="agent-hud__meta">
        <div>
          <div className="field__hint">Tổng tiền hàng (grossTotalVnd)</div>
          <strong className="money">{formatVndCurrency(quote.grossTotalVnd)}</strong>
        </div>
        <div>
          <div className="field__hint">
            Cọc VietQR ({proposal.depositRateBps / 100}% • depositRequiredVnd)
          </div>
          <strong className="money text-primary">
            {formatVndCurrency(quote.depositRequiredVnd)}
          </strong>
        </div>
        <div>
          <div className="field__hint">
            Phí sàn ({proposal.platformFeeBps / 100}% • platformFeeVnd)
          </div>
          <strong className="money">{formatVndCurrency(quote.platformFeeVnd)}</strong>
        </div>
        <div>
          <div className="field__hint">Tổng thanh toán dự kiến (estimatedBuyerTotalVnd)</div>
          <strong className="money">{formatVndCurrency(quote.estimatedBuyerTotalVnd)}</strong>
        </div>
      </div>

      <div className="agent-hud__actions">
        <button
          type="button"
          className="btn btn--small"
          onClick={() => onConfirm(proposal)}
        >
          🤝 Người dùng xác nhận &amp; Lấy mã VietQR
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--small"
          onClick={onDismiss}
        >
          ✕ Hủy đề xuất
        </button>
      </div>
    </section>
  );
}

interface B2bMarketplaceProps {
  workspaceId: string;
  role: string;
  globalAgentJsonLdView?: boolean;
  externalHudRendered?: boolean;
  confirmedProposal?: BookingProposal | null;
  onConsumeConfirmedProposal?: () => void;
  onOpenRoiCalculator?: () => void;
}

export function B2bMarketplace({
  workspaceId,
  role,
  globalAgentJsonLdView = false,
  externalHudRendered = false,
  confirmedProposal = null,
  onConsumeConfirmedProposal,
  onOpenRoiCalculator,
}: B2bMarketplaceProps) {
  const [activeTab, setActiveTab] = useState<'WEEKLY_CATALOG' | 'SEASONAL_PREORDER'>('WEEKLY_CATALOG');
  const [lots, setLots] = useState<SupplyLotView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-lot view mode toggle: 'human' | 'agent'
  const [lotViewOverrides, setLotViewOverrides] = useState<Record<string, 'human' | 'agent'>>({});
  const [svgVariant, setSvgVariant] = useState<'clean' | 'sketch'>('clean');

  // Agent Co-Pilot Proposal state
  const [stagedProposal, setStagedProposal] = useState<BookingProposal | null>(() =>
    getStagedProposal(),
  );
  const [agentNotice, setAgentNotice] = useState<string | null>(null);

  // Booking Modal State
  const [selectedLot, setSelectedLot] = useState<SupplyLotView | null>(null);
  const [bookingQty, setBookingQty] = useState<number>(10);
  const [shopName, setShopName] = useState('');
  const [shopPhone, setShopPhone] = useState('');
  const [destMarket, setDestMarket] = useState('Chợ hoa Hồ Thị Kỷ, Quận 10');
  const [bookingNote, setBookingNote] = useState('');
  const [bookingExpectedRevision, setBookingExpectedRevision] = useState<string | undefined>(
    undefined,
  );
  const [bookingResult, setBookingResult] = useState<{
    bookingCode: string;
    /** Null when this deployment has no receiving account configured. */
    vietqr: VietQrPayloadView | null;
  } | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [bookingSubmitting, setBookingSubmitting] = useState(false);
  // One key per booking intent: minted when the booking form opens for a lot,
  // reused on every retry of that submission, replaced after it succeeds.
  const [bookingKey, setBookingKey] = useState<string>(() => newIdempotencyKey());

  // Create Lot State (For Nurseries)
  const [showCreateLot, setShowCreateLot] = useState(false);
  const [newLotName, setNewLotName] = useState('');
  const [newLotSpecies, setNewLotSpecies] = useState('');
  const [newLotPrice, setNewLotPrice] = useState(150000);
  const [newLotDepositRate, setNewLotDepositRate] = useState(4000);
  const [newLotMoq, setNewLotMoq] = useState(10);
  const [newLotTotal, setNewLotTotal] = useState(100);
  const [newLotCutDate, setNewLotCutDate] = useState('2026-11-05');
  const [newLotSpec, setNewLotSpec] = useState('Chiều cao 60cm, tán tròn 50cm, nụ đều chuẩn');
  const [newLotMedia, setNewLotMedia] = useState('https://images.unsplash.com/photo-1592150621744-aca64f48394a');
  const [createLotSuccess, setCreateLotSuccess] = useState<string | null>(null);

  const loadLots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchB2bLots(workspaceId, activeTab);
      setLots(res.lots);
      if (typeof window !== 'undefined' && window.__SADEC_AGENT_BRIDGE__) {
        window.__SADEC_AGENT_BRIDGE__.syncLots(res.lots);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được danh mục lô hàng.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, activeTab]);

  useEffect(() => {
    void loadLots();
  }, [loadLots]);

  useEffect(() => {
    return subscribeProposals((proposal) => {
      setStagedProposal(proposal);
    });
  }, []);

  const handleOpenBooking = useCallback(
    (lot: SupplyLotView, initialQty?: number, expectedRev?: string) => {
      setSelectedLot(lot);
      setBookingQty(initialQty ?? lot.moq_units);
      setBookingExpectedRevision(expectedRev ?? resolveLotRevision(lot));
      setBookingResult(null);
      setBookingError(null);
      setBookingKey(newIdempotencyKey());
    },
    [],
  );

  const applyConfirmedProposal = useCallback(
    (proposal: BookingProposal) => {
      if (proposal.workspaceId !== null && proposal.workspaceId !== workspaceId) {
        // Made in another workspace: not an offer here. Drop it and say so.
        setAgentNotice('Đề xuất của Agent thuộc không gian làm việc khác nên đã bị hủy.');
        clearStagedProposal();
        return;
      }
      const matched = lots.find((l) => l.id === proposal.lotId);
      if (matched === undefined) {
        // The proposal names a lot this catalog does not currently list. The
        // screen must not invent one: a synthesized lot would show made-up
        // availability, MOQ and a ship date beside a real booking button. The
        // proposal was made against a revision of a listing that has since
        // changed (sold out, archived, or withdrawn), so it is dropped.
        setAgentNotice(
          'Lô trong đề xuất của Agent không còn trong danh mục hiện tại (đã đổi trạng thái hoặc bị thu hồi). Đề xuất đã bị hủy — vui lòng tải lại danh mục.',
        );
        clearStagedProposal();
        return;
      }
      if (matched.revision !== proposal.expectedRevision) {
        // The listing moved between the proposal and the confirmation. The
        // server would refuse the booking on `expected_revision` anyway; say so
        // here, before the form opens, so the person is not told a stale lot is
        // bookable.
        setAgentNotice(
          'Tồn kho lô đã thay đổi kể từ lúc Agent đề xuất. Đề xuất đã bị hủy — vui lòng đọc lại danh mục.',
        );
        clearStagedProposal();
        return;
      }
      setShopName(proposal.buyerShopName);
      setShopPhone(proposal.buyerContactPhone);
      setDestMarket(proposal.destinationMarket);
      setBookingNote(proposal.note ?? '');
      handleOpenBooking(matched, proposal.quantity, proposal.expectedRevision);
      clearStagedProposal();
    },
    [lots, workspaceId, handleOpenBooking],
  );

  useEffect(() => {
    if (confirmedProposal) {
      applyConfirmedProposal(confirmedProposal);
      onConsumeConfirmedProposal?.();
    }
  }, [confirmedProposal, applyConfirmedProposal, onConsumeConfirmedProposal]);

  const handleAgentProposeClick = (lot: SupplyLotView) => {
    setAgentNotice(null);
    const bridge =
      typeof window !== 'undefined' ? window.__SADEC_AGENT_BRIDGE__ : undefined;
    if (!bridge) {
      setAgentNotice('Chưa kết nối được Agent Bridge trên trình duyệt này.');
      return;
    }
    bridge.syncLots(lots);
    const revision = resolveLotRevision(lot);
    const result = bridge.proposeBooking({
      lotId: lot.id,
      quantity: lot.moq_units,
      expectedRevision: revision,
      buyerShopName: shopName || 'Shop Hoa Sài Gòn',
      buyerContactPhone: shopPhone || '0909123456',
      destinationMarket: destMarket,
    });
    if (result.status === 'REJECTED') {
      setAgentNotice(result.reason);
    }
  };

  const isLotInAgentView = (lotId: string): boolean => {
    const override = lotViewOverrides[lotId];
    if (override !== undefined) {
      return override === 'agent';
    }
    return globalAgentJsonLdView;
  };

  const toggleLotView = (lotId: string) => {
    const current = isLotInAgentView(lotId);
    setLotViewOverrides((prev) => ({
      ...prev,
      [lotId]: current ? 'human' : 'agent',
    }));
  };

  const handleSubmitBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLot || bookingSubmitting) return;
    setBookingSubmitting(true);
    setBookingError(null);

    try {
      const res = await createB2bBooking(
        workspaceId,
        {
          lot_id: selectedLot.id,
          quantity: bookingQty,
          buyer_shop_name: shopName || 'Shop Hoa Sài Gòn',
          buyer_contact_phone: shopPhone || '0909123456',
          destination_market: destMarket,
          expected_revision: bookingExpectedRevision ?? null,
          note: bookingNote || null,
        },
        bookingKey,
      );

      setBookingResult({
        bookingCode: res.booking.booking_code,
        vietqr: res.deposit_vietqr,
      });
      // The intent is spent; a further booking from this form is a new one.
      setBookingKey(newIdempotencyKey());
      await loadLots();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'revision_conflict' || err.code === 'insufficient_stock')) {
        // The lot moved under us. Reload, re-point the form at the fresh
        // revision, and keep what was typed; the person decides whether to
        // resend. A resend is a new intent against new data, so a new key.
        const refreshed = await fetchB2bLots(workspaceId, activeTab).catch(() => null);
        const fresh = refreshed?.lots.find((l) => l.id === selectedLot.id);
        if (fresh) {
          setLots(refreshed?.lots ?? lots);
          setSelectedLot(fresh);
          setBookingExpectedRevision(resolveLotRevision(fresh));
        }
        setBookingKey(newIdempotencyKey());
        setBookingError(
          `${err.message} Dữ liệu lô đã được tải lại${fresh ? ` (còn ${fresh.available_units} ${fresh.unit})` : ''}; kiểm tra rồi gửi lại nếu vẫn muốn đặt.`,
        );
      } else {
        setBookingError(err instanceof Error ? err.message : 'Đặt giữ lô hàng thất bại.');
      }
    } finally {
      setBookingSubmitting(false);
    }
  };

  const [creatingLot, setCreatingLot] = useState(false);

  const handleCreateLotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingLot) return;
    setCreatingLot(true);
    try {
      await createB2bLot(workspaceId, {
        name: newLotName,
        mode: activeTab,
        species: newLotSpecies || newLotName,
        grade: 'A',
        pot_diameter_cm: 60,
        height_cm: 70,
        canopy_cm: 60,
        bud_specification: newLotSpec,
        media_proof_url: newLotMedia,
        unit: 'chậu',
        unit_price_vnd: newLotPrice,
        deposit_rate_bps: newLotDepositRate,
        moq_units: newLotMoq,
        total_units: newLotTotal,
        cut_or_ship_date: newLotCutDate,
      });
      setCreateLotSuccess('Đã đăng lô hàng thành công lên sàn B2B!');
      setShowCreateLot(false);
      await loadLots();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể tạo lô hàng.');
    } finally {
      setCreatingLot(false);
    }
  };

  const origin =
    typeof window !== 'undefined' && window.location
      ? window.location.origin
      : 'https://sadec-flow.local';

  const modalQuote =
    selectedLot !== null
      ? calculateBookingQuote({
          quantity:
            Number.isInteger(bookingQty) && bookingQty > 0
              ? bookingQty
              : selectedLot.moq_units,
          unitPriceVnd: selectedLot.unit_price_vnd,
          depositRateBps: selectedLot.deposit_rate_bps,
          platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
        })
      : null;

  return (
    <div className="b2b-marketplace">
      {!externalHudRendered && (
        <AgentProposalHud
          proposal={stagedProposal}
          onConfirm={applyConfirmedProposal}
          onDismiss={() => clearStagedProposal()}
        />
      )}

      {agentNotice && (
        <div className="margin-bottom-16">
          <ErrorState title="Thông báo từ Agent Co-Pilot">
            <p>{agentNotice}</p>
          </ErrorState>
        </div>
      )}

      <section className="trust-strip" aria-label="Cam kết bảo chứng Bộ đôi Chắc tiền & Giá gốc">
        <div className="trust-strip__badges">
          <span className="trust-strip__item">
            🛡️ <strong>Cọc tươi 30–50% VietQR Escrow</strong> (Chắc tiền giữ giàn)
          </span>
          <span className="trust-strip__item">
            💎 <strong>0đ kê giá trung gian</strong> (Tiết kiệm 20–35% giá vốn)
          </span>
          <span className="trust-strip__item">
            🔄 <strong>Hoàn cọc 100%</strong> (Nếu kiểm định sai quy cách nụ/tán)
          </span>
        </div>
        {onOpenRoiCalculator && (
          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={onOpenRoiCalculator}
          >
            🧮 Tính mức tiết kiệm &amp; cọc Escrow
          </button>
        )}
      </section>

      <div className="bento-grid bento-grid--spaced">
        <div className="panel bento-hero">
          <div className="panel__header">
            <div>
              <h2 className="panel__title margin-0">
                Sàn B2B Hoa Kiểng Sa Đéc → TP.HCM
              </h2>
              <p className="field__hint margin-0">
                <strong>Bộ đôi Chắc tiền &amp; Giá gốc:</strong> Nhà vườn cầm chắc cọc VietQR Escrow 30–50% • Shop TP.HCM mua thẳng giá gốc (0đ kê giá, sai nụ hoàn cọc 100%)
              </p>
            </div>
            {role !== 'workspace_operator' && (
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => setShowCreateLot(!showCreateLot)}
              >
                {showCreateLot ? 'Đóng form đăng lô' : '+ Nhà vườn đăng lô mới'}
              </button>
            )}
          </div>

          {createLotSuccess && (
            <div className="margin-top-12">
              <SuccessState title={createLotSuccess} />
            </div>
          )}

          {showCreateLot && (
            <form onSubmit={handleCreateLotSubmit} className="lot-create-form">
              <h3 className="section-subhead margin-0 margin-bottom-8">Đăng lô hàng xuất khẩu / B2B</h3>
              <div className="grid grid--two">
                <div className="field">
                  <label className="field__label">Tên lô hoa kiểng</label>
                  <input required value={newLotName} onChange={(e) => setNewLotName(e.target.value)} placeholder="VD: Cúc mâm xôi vàng Sa Đéc" />
                </div>
                <div className="field">
                  <label className="field__label">Chế độ phân phối</label>
                  <select
                    value={activeTab}
                    onChange={(e) =>
                      setActiveTab(
                        e.target.value === 'SEASONAL_PREORDER'
                          ? 'SEASONAL_PREORDER'
                          : 'WEEKLY_CATALOG',
                      )
                    }
                  >
                    <option value="WEEKLY_CATALOG">Hàng nhập hàng tuần (Kiểng lá/nội thất)</option>
                    <option value="SEASONAL_PREORDER">Sổ đặt trước vụ Tết (Cúc, Vạn thọ, Mai)</option>
                  </select>
                </div>
                <div className="field">
                  <label className="field__label">Đơn giá sỉ (VND/chậu)</label>
                  <input type="number" required min={1000} step={1000} value={newLotPrice} onChange={(e) => setNewLotPrice(Number(e.target.value))} />
                </div>
                <div className="field">
                  <label className="field__label">Tỷ lệ đặt cọc (% bảo chứng)</label>
                  <select value={newLotDepositRate} onChange={(e) => setNewLotDepositRate(Number(e.target.value))}>
                    <option value={3000}>30% cọc</option>
                    <option value={4000}>40% cọc (Chuẩn khuyến nghị)</option>
                    <option value={5000}>50% cọc (Vụ Tết cao điểm)</option>
                  </select>
                </div>
                <div className="field">
                  <label className="field__label">Số lượng đặt tối thiểu (MOQ)</label>
                  <input type="number" required min={1} value={newLotMoq} onChange={(e) => setNewLotMoq(Number(e.target.value))} />
                </div>
                <div className="field">
                  <label className="field__label">Tổng số lượng mở bán</label>
                  <input type="number" required min={1} value={newLotTotal} onChange={(e) => setNewLotTotal(Number(e.target.value))} />
                </div>
                <div className="field">
                  <label className="field__label">Ngày cắt cành / xuất bến dự kiến</label>
                  <input type="date" required value={newLotCutDate} onChange={(e) => setNewLotCutDate(e.target.value)} />
                </div>
                <div className="field">
                  <label className="field__label">Cam kết nụ / quy cách kiểm định</label>
                  <input required value={newLotSpec} onChange={(e) => setNewLotSpec(e.target.value)} />
                </div>
              </div>
              <button type="submit" className="btn btn--top-spaced" disabled={creatingLot} aria-busy={creatingLot}>
                {creatingLot ? 'Đang đăng lô...' : 'Đăng lô hàng lên sàn'}
              </button>
            </form>
          )}

          <div className="action-cluster margin-top-16">
            <button
              type="button"
              className={`btn btn--small ${activeTab === 'WEEKLY_CATALOG' ? '' : 'btn--secondary'}`}
              onClick={() => setActiveTab('WEEKLY_CATALOG')}
            >
              Hàng Nhập Hàng Tuần (Kiểng lá &amp; Nội thất)
            </button>
            <button
              type="button"
              className={`btn btn--small ${activeTab === 'SEASONAL_PREORDER' ? '' : 'btn--secondary'}`}
              onClick={() => setActiveTab('SEASONAL_PREORDER')}
            >
              Sổ Đặt Trước Vụ Tết (Cúc mâm xôi, Mai vàng)
            </button>
          </div>
        </div>

        <div className="panel bento-side">
          <div className="panel__header">
            <h3 className="panel__title margin-0">
              Bề Mặt Đôi Human ↔ AI Agent
            </h3>
            <span className="role">WebMCP + AEO</span>
          </div>
          <p className="field__hint margin-bottom-8">
            Mỗi lô hoa kiểng phát hành song song thẻ giao diện người dùng và <code>Schema.org/Product</code> JSON-LD (0% PII) kèm khóa <code>revision</code> chống đặt trùng.
          </p>
          <div className="action-cluster">
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={() =>
                setSvgVariant((v) => (v === 'clean' ? 'sketch' : 'clean'))
              }
            >
              Sơ đồ SVG: {svgVariant === 'clean' ? 'Clean' : 'Sketch'}
            </button>
          </div>
        </div>

        <div className="panel bento-full">
          <ProvenanceSvg variant={svgVariant} />
        </div>
      </div>

      {loading && <LoadingState title="Đang tải danh mục lô hàng..." />}
      {error && (
        <ErrorState title="Lỗi tải dữ liệu">
          <p>{error}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void loadLots()}>
            Thử lại
          </button>
        </ErrorState>
      )}

      {!loading && !error && lots.length === 0 && (
        <EmptyState title="Chưa có lô hàng nào đang mở bán trong danh mục này." />
      )}

      <div className="bento-grid">
        {lots.map((lot) => {
          const agentView = isLotInAgentView(lot.id);
          const projection = toPublicProjection(lot);
          const jsonLdObject = buildLotJsonLd(projection, origin);

          return (
            <div key={lot.id} className="panel lot-card bento-half">
              <div>
                <div className="lot-card__header">
                  <div className="action-cluster">
                    <span className="badge badge--success">
                      {lot.mode === 'WEEKLY_CATALOG' ? 'Hàng tuần' : 'Đặt Tết'}
                    </span>
                    <span className="field__hint text-bold">{lot.lot_code}</span>
                    <span className="field__hint text-mono">
                      REV: {lot.revision ?? projection.revision ?? '—'}
                    </span>
                  </div>

                  <button
                    type="button"
                    className="lot-card__view-toggle"
                    onClick={() => toggleLotView(lot.id)}
                  >
                    {agentView ? '👤 Human View (JSON-LD)' : '🤖 Agent JSON-LD View'}
                  </button>
                </div>

                <h3 className="lot-card__title">
                  {lot.name}
                </h3>
                <p className="field__hint lot-card__nursery">
                  Nhà vườn: <strong>{lot.nursery_name ?? 'Vườn Sa Đéc'}</strong> ({lot.hamlet_area ?? 'Tân Quy Đông'})
                </p>

                {agentView ? (
                  <pre className="lot-card__jsonld">
                    {JSON.stringify(jsonLdObject, null, 2)}
                  </pre>
                ) : (
                  <>
                    <div className="sunken-card">
                      <div className="kv-row">
                        <span>Quy cách:</span>
                        <strong>{lot.grade} • Cao {lot.height_cm}cm • Tán {lot.canopy_cm}cm</strong>
                      </div>
                      <div className="kv-row">
                        <span>Tiêu chuẩn nụ:</span>
                        <span className="text-ink">{lot.bud_specification}</span>
                      </div>
                      <div className="kv-row--last">
                        <span>Ngày xuất bến:</span>
                        <strong>{lot.cut_or_ship_date}</strong>
                      </div>
                    </div>

                    <div className="lot-card__price-row">
                      <div>
                        <span className="money money--total">{formatVnd(lot.unit_price_vnd)}</span>
                        <span className="money__unit">đ / {lot.unit}</span>
                      </div>
                      <div className="field__hint">
                        Cọc: <strong>{lot.deposit_rate_bps / 100}%</strong> • MOQ: <strong>{lot.moq_units}</strong> {lot.unit}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="lot-card__footer">
                <div className="field__hint">
                  Còn: <strong>{lot.available_units}</strong> / {lot.total_units} {lot.unit}
                </div>
                <div className="action-cluster">
                  <button
                    type="button"
                    className="btn btn--secondary btn--small"
                    disabled={lot.available_units < lot.moq_units}
                    onClick={() => handleAgentProposeClick(lot)}
                  >
                    🤖 AI Đề xuất đặt giữ
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={lot.available_units < lot.moq_units}
                    onClick={() => handleOpenBooking(lot)}
                  >
                    {lot.available_units >= lot.moq_units ? 'Đặt giữ lô ngay' : 'Hết hàng'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Booking Modal */}
      {selectedLot && modalQuote && (
        <div className="modal-backdrop">
          <div
            className="panel modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-dialog-title"
          >
            <div className="panel__header">
              <h3 className="panel__title margin-0" id="booking-dialog-title">
                Đặt Giữ Lô: {selectedLot.name}
              </h3>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => setSelectedLot(null)}
              >
                ✕ Đóng
              </button>
            </div>

            {!bookingResult ? (
              <form onSubmit={handleSubmitBooking}>
                <div className="field">
                  <label className="field__label" htmlFor="booking-qty">Số lượng đặt ({selectedLot.unit})</label>
                  <input
                    id="booking-qty"
                    type="number"
                    required
                    min={selectedLot.moq_units}
                    max={selectedLot.available_units}
                    value={bookingQty}
                    onChange={(e) => setBookingQty(Number(e.target.value))}
                  />
                  <span className="field__hint">Tối thiểu: {selectedLot.moq_units} {selectedLot.unit}</span>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="booking-shop-name">Tên Shop hoa tại TP.HCM</label>
                  <input
                    id="booking-shop-name"
                    required
                    value={shopName}
                    onChange={(e) => setShopName(e.target.value)}
                    placeholder="VD: Tiệm hoa Tháng Năm"
                  />
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="booking-shop-phone">Số điện thoại liên hệ</label>
                  <input
                    id="booking-shop-phone"
                    required
                    inputMode="tel"
                    value={shopPhone}
                    onChange={(e) => setShopPhone(e.target.value)}
                    placeholder="090..."
                  />
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="booking-destination">Điểm giao nhận tại TP.HCM</label>
                  <select id="booking-destination" value={destMarket} onChange={(e) => setDestMarket(e.target.value)}>
                    <option value="Chợ hoa Hồ Thị Kỷ, Quận 10">Chợ hoa Hồ Thị Kỷ, Quận 10</option>
                    <option value="Chợ đầu mối Đầm Sen, Quận 11">Chợ đầu mối Đầm Sen, Quận 11</option>
                    <option value="Chợ đầu mối Thủ Đức">Chợ đầu mối Thủ Đức</option>
                    <option value="Giao tận shop nội thành TP.HCM">Giao tận shop nội thành TP.HCM</option>
                  </select>
                </div>

                <div className="sunken-card margin-bottom-16">
                  <div className="kv-row">
                    <span>Tổng tiền hàng tạm tính:</span>
                    <strong className="money">{formatVndCurrency(modalQuote.grossTotalVnd)}</strong>
                  </div>
                  <div className="kv-row">
                    <span>Cọc bảo chứng ({selectedLot.deposit_rate_bps / 100}%):</span>
                    <strong className="money text-primary">
                      {formatVndCurrency(modalQuote.depositRequiredVnd)}
                    </strong>
                  </div>
                  <div className="kv-row--muted">
                    <span>Phí sàn (3% tính khi nghiệm thu):</span>
                    <span>{formatVndCurrency(modalQuote.platformFeeVnd)}</span>
                  </div>
                </div>

                {bookingError && <p className="field__error" role="alert">{bookingError}</p>}

                <button type="submit" className="btn btn--full" disabled={bookingSubmitting} aria-busy={bookingSubmitting}>
                  {bookingSubmitting ? 'Đang tạo đơn đặt giữ...' : 'Xác nhận đặt giữ & Lấy mã VietQR'}
                </button>
              </form>
            ) : (
              <div>
                <SuccessState title="Đặt giữ lô thành công!" />
                <div className="qr-card-centered">
                  <p className="field__hint margin-0">Mã đơn đặt giữ:</p>
                  <h4 className="qr-voucher__code">
                    {bookingResult.bookingCode}
                  </h4>

                  {bookingResult.vietqr === null ? (
                    <div className="qr-voucher" role="alert">
                      <p className="qr-voucher__title">CHƯA CẤU HÌNH TÀI KHOẢN NHẬN CỌC</p>
                      <p className="field__hint">
                        Hệ thống chưa có tài khoản nhận tiền cọc cho môi trường này, nên không hiển thị mã QR.
                        Đơn đặt giữ <strong>{bookingResult.bookingCode}</strong> vẫn được ghi nhận;{' '}
                        <strong>không chuyển tiền</strong> theo bất kỳ số tài khoản nào khác. Người phụ trách sàn sẽ
                        liên hệ để xác nhận cọc kèm mã tham chiếu ngân hàng.
                      </p>
                    </div>
                  ) : (
                    <div className="qr-voucher">
                      <p className="qr-voucher__title">MÃ VIETQR BẢO CHỨNG CỌC</p>
                      <div className="qr-payload--sunken">{bookingResult.vietqr.emvPayload}</div>
                      <div className="qr-meta-left">
                        <div>
                          Số tiền cọc:{' '}
                          <strong className="money">{formatVndCurrency(bookingResult.vietqr.amountVnd)}</strong>
                        </div>
                        <div>
                          Nội dung CK: <strong className="text-primary">{bookingResult.vietqr.transferNote}</strong>
                        </div>
                        <div>
                          Tài khoản nhận: <strong>{bookingResult.vietqr.bankBin} - {bookingResult.vietqr.accountNumber}</strong>
                        </div>
                        <div>Chủ tài khoản: <strong>{bookingResult.vietqr.accountHolder}</strong></div>
                      </div>
                    </div>
                  )}

                  <p className="field__hint margin-top-12">
                    Sổ cái bảo chứng là <strong>mô phỏng</strong>: mỗi lần nhận cọc hay giải ngân là một bút toán do
                    người phụ trách sàn xác nhận kèm mã tham chiếu, không phải giao dịch ngân hàng tự động.
                  </p>

                  <button
                    type="button"
                    className="btn btn--secondary margin-top-16"
                    onClick={() => setSelectedLot(null)}
                  >
                    Hoàn tất &amp; Quay lại
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
