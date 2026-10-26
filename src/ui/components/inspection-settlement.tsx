import { useState, useEffect, useCallback } from 'react';
import {
  fetchB2bBookings,
  fetchHubTrips,
  inspectAndSettleBookingApi,
  type B2bBookingView,
  type HubDispatchTripView,
} from '../api.ts';
import { formatVnd, formatVndWithUnit } from '../format.ts';
import { EmptyState, ErrorState, LoadingState, SuccessState } from './states.tsx';

interface InspectionSettlementProps {
  workspaceId: string;
  role: string;
}

/** The three inspection outcomes §7.3 defines, and nothing else. */
type InspectionChoice = 'FULL_ACCEPT' | 'PARTIAL_DEFECT' | 'REJECT_ALL';

export function InspectionSettlement({ workspaceId, role }: InspectionSettlementProps) {
  const [bookings, setBookings] = useState<B2bBookingView[]>([]);
  const [packages, setPackages] = useState<
    { packageData: HubDispatchTripView['packages'][number]; trip: HubDispatchTripView }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Station state
  const [selectedPackageId, setSelectedPackageId] = useState('');
  const [choice, setChoice] = useState<InspectionChoice>('FULL_ACCEPT');
  const [defectiveQty, setDefectiveQty] = useState<number>(0);
  const [settlementNote, setSettlementNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [settlementError, setSettlementError] = useState<string | null>(null);
  const [settlementResult, setSettlementResult] = useState<{
    bookingCode: string;
    settlement: {
      acceptedUnits: number;
      defectiveUnits: number;
      acceptedValueVnd: number;
      nurseryDeductionVnd: number;
      platformFeeRetainedVnd: number;
      buyerBalanceRequiredVnd: number;
      buyerRefundVnd: number;
      nurseryPayoutVnd: number;
      platformOutlayVnd: number;
      totalCollectedFromBuyerVnd: number;
    };
    balanceQr: { transferNote: string; amountVnd: number; emvPayload: string } | null;
  } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bookingPage, tripPage] = await Promise.all([
        fetchB2bBookings(workspaceId),
        fetchHubTrips(workspaceId),
      ]);

      // Only bookings in a post-dispatch state can be inspected, and the shop may
      // only see its own. The server already enforces this; the filter here keeps
      // the queue an operator reads from showing rows that would be refused.
      const inspectable = bookingPage.bookings.filter((b) =>
        ['ESCROW_HELD', 'HUB_CONSOLIDATED', 'IN_TRANSIT'].includes(b.status),
      );
      setBookings(inspectable);

      const flatPackages: { packageData: HubDispatchTripView['packages'][number]; trip: HubDispatchTripView }[] = [];
      for (const trip of tripPage.trips) {
        for (const pkg of trip.packages ?? []) {
          flatPackages.push({ packageData: pkg, trip });
        }
      }
      setPackages(flatPackages.filter(({ packageData }) =>
        packageData.buyer_inspection_status === 'PENDING' ||
        packageData.buyer_inspection_status === 'PARTIAL_DEFECT',
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được danh sách kiện hàng chờ nghiệm thu.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const selectedBooking: B2bBookingView | undefined =
    bookings.find((b) => b.id === selectedPackageId) ??
    // The station scans a package, but the settlement reads the booking behind it.
    bookings.find((b) =>
      packages.some((p) => p.packageData.booking_id === b.id && String(p.packageData.id) === selectedPackageId),
    );

  const handleSettleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBooking) return;

    let acceptedUnits = selectedBooking.quantity;
    let defectives = 0;

    if (choice === 'PARTIAL_DEFECT') {
      acceptedUnits = selectedBooking.quantity - defectiveQty;
      defectives = defectiveQty;
    } else if (choice === 'REJECT_ALL') {
      acceptedUnits = 0;
      defectives = selectedBooking.quantity;
    }

    setSubmitting(true);
    setSettlementError(null);
    setSettlementResult(null);

    try {
      const res = await inspectAndSettleBookingApi(workspaceId, {
        booking_id: selectedBooking.id,
        accepted_units: acceptedUnits,
        defective_units: defectives,
        fault_party: defectives > 0 ? 'NURSERY' : 'NONE',
        note: settlementNote || undefined,
      });

      setSettlementResult({
        bookingCode: res.booking.booking_code,
        settlement: res.settlement,
        balanceQr: res.balance_vietqr,
      });
      await loadData();
    } catch (err) {
      setSettlementError(err instanceof Error ? err.message : 'Không thể thực hiện nghiệm thu.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="inspection-settlement">
      <div className="panel margin-bottom-16">
        <h2 className="panel__title margin-0">
          Trạm Nghiệm Thu &amp; Đối Soát Tự Động tại Shop TP.HCM
        </h2>
        <p className="field__hint margin-0">
          Quét mã QR kiện hàng Niêm phong bên Hub Sa Đéc (HMAC-SHA256) • Đối chiếu quy cách cam kết • Thanh toán số dư qua VietQR
        </p>
      </div>

      {loading && <LoadingState title="Đang tải dữ liệu trạm kiểm..." />}
      {error && (
        <ErrorState title="Lỗi tải dữ liệu">
          <p>{error}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void loadData()}>
            Thử lại
          </button>
        </ErrorState>
      )}

      {!loading && !error && packages.length === 0 && bookings.length === 0 && (
        <EmptyState title="Hiện tại không có kiện hàng nào cần nghiệm thu tại shop." />
      )}

      {!loading && !error && (bookings.length > 0 || packages.length > 0) && (
        <div className="grid grid--two">
          <section className="panel" aria-labelledby="queue-heading">
            <h3 className="panel__title" id="queue-heading">
              Kiện hàng đến ({packages.length})
            </h3>

            <div className="stack-list">
              {packages.map(({ packageData, trip }) => {
                const booking = bookings.find((b) => b.id === packageData.booking_id);
                const isSelected = selectedPackageId === String(packageData.id);
                return (
                  <button
                    key={packageData.id}
                    type="button"
                    className={`btn btn--secondary queue-card ${isSelected ? 'queue-card--active' : ''}`}
                    onClick={() => {
                      setSelectedPackageId(String(packageData.id));
                      setSettlementResult(null);
                    }}
                  >
                    <div className="queue-card__title">{packageData.package_label}</div>
                    <div className="field__hint queue-card__hint">
                      Mã KH: {booking?.booking_code} • {packageData.units_count} chậu • Xe {trip.truck_plate}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel" aria-labelledby="settle-heading">
            <h3 className="panel__title" id="settle-heading">
              Xác nhận nghiệm thu &amp; Chốt sổ cái
            </h3>

            {selectedBooking ? (
              <form onSubmit={handleSettleSubmit}>
                <div className="sunken-card">
                  <h4 className="section-subhead margin-0">{selectedBooking.lot_name}</h4>
                  <div className="meta-grid">
                    <div>Mã đơn: <strong>{selectedBooking.booking_code}</strong></div>
                    <div>Shop nhận: <strong>{selectedBooking.buyer_shop_name}</strong></div>
                    <div>Số lượng đặt: <strong>{selectedBooking.quantity} {selectedBooking.quantity === 1 ? 'chậu' : 'chậu'}</strong></div>
                    <div>Đơn giá: <strong className="money">{formatVnd(selectedBooking.unit_price_vnd)} đ</strong></div>
                    <div>Tiền cọc đang giữ trong Escrow: <strong className="money">{formatVnd(selectedBooking.deposit_paid_vnd)} đ</strong></div>
                    <div>Điểm giao: {selectedBooking.destination_market}</div>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">Trạng thái kiểm tra tại shop</label>
                  <select value={choice} onChange={(e) => setChoice(e.target.value as InspectionChoice)}>
                    <option value="FULL_ACCEPT">Đạt 100% quy cách</option>
                    <option value="PARTIAL_DEFECT">Báo lỗi một phần (khuyết tật quy cách do nhà vườn)</option>
                    <option value="REJECT_ALL">Từ chối 100% do hàng hỏng/lỗi vườn</option>
                  </select>
                </div>

                {choice === 'PARTIAL_DEFECT' && (
                  <div className="field">
                    <label className="field__label">Số chậu bị lỗi (do nhà vường)</label>
                    <input
                      type="number"
                      min={1}
                      max={selectedBooking.quantity}
                      value={defectiveQty}
                      onChange={(e) => setDefectiveQty(Number(e.target.value))}
                    />
                  </div>
                )}

                <div className="field">
                  <label className="field__label">Ghi chú nghiệm thu</label>
                  <textarea
                    value={settlementNote}
                    onChange={(e) => setSettlementNote(e.target.value)}
                    maxLength={500}
                    placeholder="VD: Nụ đều, đóng gói kỹ. 5 chậu vỡ chậu."
                  />
                </div>

                <button type="submit" className="btn" disabled={submitting}>
                  {submitting ? 'Đang ghi sổ cái...' : 'Xác nhận nghiệm thu & Chốt sổ cái Escrow'}
                </button>
              </form>
            ) : (
              <p className="field__hint">Chọn một kiện hàng trong danh sách bên trái để nghiệm thu.</p>
            )}

            {settlementError && (
              <ErrorState title="Không thể chốt sổ cái">
                <p>{settlementError}</p>
              </ErrorState>
            )}
          </section>
        </div>
      )}

      {settlementResult && (
        <section className="panel margin-top-16" aria-labelledby="result-heading">
          <h3 className="panel__title" id="result-heading">
            Kết quả đối soát &amp; Giải ngân sổ cái cho mã đơn {settlementResult.bookingCode}
          </h3>
          <SuccessState title="Đã ghi sổ cái bất biến thành công." />

          <div className="table-wrap">
            <table className="table table--spaced">
              <caption className="sr-only">Bảng đối soát thanh toán cho đơn hàng này</caption>
              <tbody>
                <tr>
                  <th scope="row">Cây đạt quy cách nghiệm thu</th>
                  <td className="num">{settlementResult.settlement.acceptedUnits} chậu</td>
                  <td className="num money">{formatVndWithUnit(settlementResult.settlement.acceptedValueVnd)}</td>
                </tr>
                {settlementResult.settlement.defectiveUnits > 0 && (
                  <tr>
                    <th scope="row">Bị lỗi (trừ vào phần nhà vườn)</th>
                    <td className="num">{settlementResult.settlement.defectiveUnits} chậu</td>
                    <td className="num money text-danger">
                      {formatVndWithUnit(-settlementResult.settlement.nurseryDeductionVnd)}
                    </td>
                  </tr>
                )}
                <tr>
                  <th scope="row">Phí sàn thu về khi nghiệm thu (2-5%)</th>
                  <td className="num">Sàn thu</td>
                  <td className="num money text-primary">
                    {formatVndWithUnit(settlementResult.settlement.platformFeeRetainedVnd)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Tiền chuyển giải ngân cho nhà vườn Sa Đéc</th>
                  <td className="num">Vườn nhận</td>
                  <td className="num money">
                    {formatVndWithUnit(settlementResult.settlement.nurseryPayoutVnd)}
                  </td>
                </tr>
                <tr className="row--highlight-primary">
                  <th scope="row" colSpan={2}>
                    Shop cần thanh toán thêm bằng VietQR (BAL)
                  </th>
                  <td className="num money money--total">
                    {formatVndWithUnit(settlementResult.settlement.buyerBalanceRequiredVnd)}
                  </td>
                </tr>
                {settlementResult.settlement.buyerRefundVnd > 0 && (
                  <tr className="row--highlight-danger">
                    <th scope="row" colSpan={2}>
                      Sàn hoàn trả tiền cọc cho shop (do hàng lỗi vườn)
                    </th>
                    <td className="num money text-danger">
                      {formatVndWithUnit(settlementResult.settlement.buyerRefundVnd)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {settlementResult.balanceQr && (
            <div className="qr-box">
              <h4 className="section-subhead margin-0">Quét mã VietQR thanh toán số dư còn lại:</h4>
              <div className="kv-row">
                <span>Số tiền cần trả:</span>
                <span className="money money--total">{formatVnd(settlementResult.balanceQr.amountVnd)} đ</span>
              </div>
              <div className="kv-row">
                <span>Nội dung chuyển khoản:</span>
                <strong className="text-primary">{settlementResult.balanceQr.transferNote}</strong>
              </div>
              <div className="qr-payload">
                {settlementResult.balanceQr.emvPayload}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
