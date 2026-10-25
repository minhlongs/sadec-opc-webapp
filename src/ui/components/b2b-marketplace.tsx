import { useState, useEffect, useCallback } from 'react';
import {
  fetchB2bLots,
  createB2bBooking,
  createB2bLot,
  confirmB2bDeposit,
  type SupplyLotView,
  type VietQrPayloadView,
} from '../api.ts';
import { formatVnd, formatVndWithUnit } from '../format.ts';
import { EmptyState, ErrorState, LoadingState, SuccessState } from './states.tsx';

interface B2bMarketplaceProps {
  workspaceId: string;
  role: string;
}

export function B2bMarketplace({ workspaceId, role }: B2bMarketplaceProps) {
  const [activeTab, setActiveTab] = useState<'WEEKLY_CATALOG' | 'SEASONAL_PREORDER'>('WEEKLY_CATALOG');
  const [lots, setLots] = useState<SupplyLotView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Booking Modal State
  const [selectedLot, setSelectedLot] = useState<SupplyLotView | null>(null);
  const [bookingQty, setBookingQty] = useState<number>(10);
  const [shopName, setShopName] = useState('');
  const [shopPhone, setShopPhone] = useState('');
  const [destMarket, setDestMarket] = useState('Chợ hoa Hồ Thị Kỷ, Quận 10');
  const [bookingNote, setBookingNote] = useState('');
  const [bookingResult, setBookingResult] = useState<{
    bookingCode: string;
    vietqr: VietQrPayloadView;
  } | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [bookingSubmitting, setBookingSubmitting] = useState(false);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được danh mục lô hàng.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, activeTab]);

  useEffect(() => {
    void loadLots();
  }, [loadLots]);

  const handleOpenBooking = (lot: SupplyLotView) => {
    setSelectedLot(lot);
    setBookingQty(lot.moq_units);
    setBookingResult(null);
    setBookingError(null);
  };

  const handleSubmitBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLot) return;
    setBookingSubmitting(true);
    setBookingError(null);

    try {
      const res = await createB2bBooking(workspaceId, {
        lot_id: selectedLot.id,
        quantity: bookingQty,
        buyer_shop_name: shopName || 'Shop Hoa Sài Gòn',
        buyer_contact_phone: shopPhone || '0909123456',
        destination_market: destMarket,
        note: bookingNote || null,
      });

      setBookingResult({
        bookingCode: res.booking.booking_code,
        vietqr: res.deposit_vietqr,
      });
      await loadLots();
    } catch (err) {
      setBookingError(err instanceof Error ? err.message : 'Đặt giữ lô hàng thất bại.');
    } finally {
      setBookingSubmitting(false);
    }
  };

  const handleCreateLotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
    }
  };

  return (
    <div className="b2b-marketplace">
      <div className="panel" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 className="panel__title" style={{ margin: 0 }}>
              Sàn B2B Hoa Kiểng Sa Đéc → TP.HCM
            </h2>
            <p className="field__hint" style={{ margin: '4px 0 0' }}>
              Đặt trước từ nhà vườn Sa Đéc xác minh • Cọc VietQR bảo chứng qua Escrow sàn • Sàn không ứng vốn (0đ Outlay)
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
          <div style={{ marginTop: 12 }}>
            <SuccessState title={createLotSuccess} />
          </div>
        )}

        {showCreateLot && (
          <form onSubmit={handleCreateLotSubmit} style={{ marginTop: 16, padding: 16, background: 'var(--surface-sunken)', borderRadius: 'var(--radius)' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Đăng lô hàng xuất khẩu / B2B</h3>
            <div className="grid grid--two">
              <div className="field">
                <label className="field__label">Tên lô hoa kiểng</label>
                <input required value={newLotName} onChange={(e) => setNewLotName(e.target.value)} placeholder="VD: Cúc mâm xôi vàng Sa Đéc" />
              </div>
              <div className="field">
                <label className="field__label">Chế độ phân phối</label>
                <select value={activeTab} onChange={(e) => setActiveTab(e.target.value as any)}>
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
            <button type="submit" className="btn" style={{ marginTop: 12 }}>Đăng lô hàng lên sàn</button>
          </form>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            className={`btn btn--small ${activeTab === 'WEEKLY_CATALOG' ? '' : 'btn--secondary'}`}
            onClick={() => setActiveTab('WEEKLY_CATALOG')}
          >
            Hàng Nhập Hàng Tuần (Kiểng lá & Nội thất)
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

      <div className="grid grid--two">
        {lots.map((lot) => (
          <div key={lot.id} className="panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <span className="role" style={{ background: '#e6efea', color: '#0f4a38', borderColor: '#0f4a38' }}>
                  {lot.mode === 'WEEKLY_CATALOG' ? 'Hàng tuần' : 'Đặt Tết'}
                </span>
                <span className="field__hint" style={{ fontWeight: 600 }}>{lot.lot_code}</span>
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px', color: 'var(--primary-strong)' }}>
                {lot.name}
              </h3>
              <p className="field__hint" style={{ margin: '0 0 8px' }}>
                Nhà vườn: <strong>{lot.nursery_name ?? 'Vườn Sa Đéc'}</strong> ({lot.hamlet_area ?? 'Tân Quy Đông'})
              </p>

              <div style={{ background: 'var(--surface-sunken)', padding: '8px 12px', borderRadius: 'var(--radius-small)', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span>Quy cách:</span>
                  <strong>{lot.grade} • Cao {lot.height_cm}cm • Tán {lot.canopy_cm}cm</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span>Tiêu chuẩn nụ:</span>
                  <span style={{ color: 'var(--ink)' }}>{lot.bud_specification}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span>Ngày xuất bến:</span>
                  <strong>{lot.cut_or_ship_date}</strong>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                <div>
                  <span className="money money--total">{formatVnd(lot.unit_price_vnd)}</span>
                  <span className="money__unit">đ / {lot.unit}</span>
                </div>
                <div className="field__hint">
                  Cọc: <strong>{lot.deposit_rate_bps / 100}%</strong> • MOQ: <strong>{lot.moq_units}</strong> {lot.unit}
                </div>
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="field__hint">
                Còn: <strong>{lot.available_units}</strong> / {lot.total_units} {lot.unit}
              </div>
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
        ))}
      </div>

      {/* Booking Modal */}
      {selectedLot && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16, zIndex: 1000
        }}>
          <div className="panel" style={{ maxWidth: 520, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 className="panel__title" style={{ margin: 0 }}>
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
                  <label className="field__label">Số lượng đặt ({selectedLot.unit})</label>
                  <input
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
                  <label className="field__label">Tên Shop hoa tại TP.HCM</label>
                  <input
                    required
                    value={shopName}
                    onChange={(e) => setShopName(e.target.value)}
                    placeholder="VD: Tiệm hoa Tháng Năm"
                  />
                </div>

                <div className="field">
                  <label className="field__label">Số điện thoại liên hệ</label>
                  <input
                    required
                    value={shopPhone}
                    onChange={(e) => setShopPhone(e.target.value)}
                    placeholder="090..."
                  />
                </div>

                <div className="field">
                  <label className="field__label">Điểm giao nhận tại TP.HCM</label>
                  <select value={destMarket} onChange={(e) => setDestMarket(e.target.value)}>
                    <option value="Chợ hoa Hồ Thị Kỷ, Quận 10">Chợ hoa Hồ Thị Kỷ, Quận 10</option>
                    <option value="Chợ đầu mối Đầm Sen, Quận 11">Chợ đầu mối Đầm Sen, Quận 11</option>
                    <option value="Chợ đầu mối Thủ Đức">Chợ đầu mối Thủ Đức</option>
                    <option value="Giao tận shop nội thành TP.HCM">Giao tận shop nội thành TP.HCM</option>
                  </select>
                </div>

                <div style={{ background: 'var(--surface-sunken)', padding: 12, borderRadius: 'var(--radius-small)', marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span>Tổng tiền hàng tạm tính:</span>
                    <strong className="money">{formatVnd(selectedLot.unit_price_vnd * bookingQty)} đ</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span>Cọc bảo chứng ({selectedLot.deposit_rate_bps / 100}%):</span>
                    <strong className="money" style={{ color: 'var(--primary-strong)' }}>
                      {formatVnd(Math.trunc((selectedLot.unit_price_vnd * bookingQty * selectedLot.deposit_rate_bps) / 10000))} đ
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--ink-muted)' }}>
                    <span>Phí sàn (3% tính khi nghiệm thu):</span>
                    <span>{formatVnd(Math.trunc((selectedLot.unit_price_vnd * bookingQty * 300) / 10000))} đ</span>
                  </div>
                </div>

                {bookingError && <p className="field__error">{bookingError}</p>}

                <button type="submit" className="btn" style={{ width: '100%' }} disabled={bookingSubmitting}>
                  {bookingSubmitting ? 'Đang tạo đơn đặt giữ...' : 'Xác nhận đặt giữ & Lấy mã VietQR'}
                </button>
              </form>
            ) : (
              <div>
                <SuccessState title="Đặt giữ lô thành công!" />
                <div style={{ textAlign: 'center', marginTop: 16 }}>
                  <p className="field__hint" style={{ marginBottom: 4 }}>Mã đơn đặt giữ:</p>
                  <h4 style={{ fontSize: 18, margin: '0 0 16px', color: 'var(--primary-strong)' }}>
                    {bookingResult.bookingCode}
                  </h4>

                  <div style={{ background: '#fff', border: '2px solid var(--border)', borderRadius: 12, padding: 16, display: 'inline-block', maxWidth: 320 }}>
                    <p style={{ fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
                      MÃ VIETQR BẢO CHỨNG CỌC ESCROW
                    </p>
                    <div style={{ background: 'var(--surface-sunken)', padding: 16, borderRadius: 8, wordBreak: 'break-all', fontSize: 11, fontFamily: 'monospace', marginBottom: 12 }}>
                      {bookingResult.vietqr.emvPayload}
                    </div>
                    <div style={{ textAlign: 'left', fontSize: 13 }}>
                      <div>Số tiền cọc: <strong className="money">{formatVnd(bookingResult.vietqr.amountVnd)} đ</strong></div>
                      <div>Nội dung CK: <strong style={{ color: 'var(--primary-strong)' }}>{bookingResult.vietqr.transferNote}</strong></div>
                      <div>Tài khoản Escrow: <strong>{bookingResult.vietqr.bankBin} - {bookingResult.vietqr.accountNumber}</strong></div>
                    </div>
                  </div>

                  <p className="field__hint" style={{ marginTop: 12 }}>
                    Chuyển khoản đúng nội dung trên. Sàn sẽ giữ tiền cọc an toàn trong Escrow và chỉ giải ngân sau khi bạn nghiệm thu đạt chất lượng tại TP.HCM.
                  </p>

                  <button
                    type="button"
                    className="btn btn--secondary"
                    style={{ marginTop: 16 }}
                    onClick={() => setSelectedLot(null)}
                  >
                    Hoàn tất & Quay lại
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
