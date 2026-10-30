import { useState, useEffect, useCallback } from 'react';
import {
  ApiError,
  confirmB2bSettlementApi,
  fetchB2bBookings,
  fetchHubTrips,
  inspectAndSettleBookingApi,
  newIdempotencyKey,
  type B2bBookingView,
  type B2bSettlementRecordView,
  type HubDispatchTripView,
  type InspectionSettlementView,
} from '../api.ts';
import { formatVnd, formatVndWithUnit } from '../format.ts';
import { EmptyState, ErrorState, LoadingState, SuccessState } from './states.tsx';

interface InspectionSettlementProps {
  workspaceId: string;
  role: string;
}

/** The three inspection outcomes §7.3 defines, and nothing else. */
type InspectionChoice = 'FULL_ACCEPT' | 'PARTIAL_DEFECT' | 'REJECT_ALL';

/** Booking states the server accepts an inspection for. Mirrors the API; the API decides. */
const INSPECTABLE = ['HUB_CONSOLIDATED', 'IN_TRANSIT'];

const SETTLEMENT_STATUS_LABEL: Record<B2bSettlementRecordView['status'], string> = {
  AWAITING_BALANCE: 'Chờ shop chuyển số dư — chưa xác nhận nhận tiền',
  READY_TO_RELEASE: 'Không còn số dư phải thu — chờ founder xác nhận giải ngân',
  RELEASED: 'Đã xác nhận đối soát — sổ cái đã ghi',
};

/**
 * Inspection at the HCM shop, and settlement confirmation by the founder.
 *
 * Two different things happen on this screen and the words keep them apart.
 * The shop *inspects*: it counts accepted and defective units, and the server
 * computes what each side now owes. Nothing is paid by that act — the result
 * is a set of obligations, and the ledger stays untouched. Later the founder
 * *confirms* the settlement, with the bank reference of the balance they saw
 * arrive; only then are the ledger rows written and the booking SETTLED.
 *
 * The ledger is simulated: it records confirmations a person typed, not bank
 * credits. The screen says so.
 */
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
  // One key per inspection intent: minted when a package is selected, kept
  // across retries of that same submission, discarded on success.
  const [inspectKey, setInspectKey] = useState<string>(() => newIdempotencyKey());
  const [settlementResult, setSettlementResult] = useState<{
    bookingCode: string;
    settlement: InspectionSettlementView;
    record: B2bSettlementRecordView;
    balanceQr: { transferNote: string; amountVnd: number; emvPayload: string } | null;
  } | null>(null);

  // Founder confirmation state
  const [confirmTarget, setConfirmTarget] = useState<string>('');
  const [balanceRef, setBalanceRef] = useState('');
  const [confirmNote, setConfirmNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmDone, setConfirmDone] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string>(() => newIdempotencyKey());

  const isFounder = role === 'founder_admin';

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bookingPage, tripPage] = await Promise.all([
        fetchB2bBookings(workspaceId),
        fetchHubTrips(workspaceId),
      ]);
      setBookings(bookingPage.bookings);

      const flatPackages: { packageData: HubDispatchTripView['packages'][number]; trip: HubDispatchTripView }[] = [];
      for (const trip of tripPage.trips) {
        for (const pkg of trip.packages ?? []) {
          flatPackages.push({ packageData: pkg, trip });
        }
      }
      // The queue shows packages whose booking the server would still accept
      // an inspection for. The server enforces this; the filter keeps the
      // queue from offering rows that would be refused.
      const inspectableIds = new Set(
        bookingPage.bookings.filter((b) => INSPECTABLE.includes(b.status)).map((b) => b.id),
      );
      setPackages(
        flatPackages.filter(
          ({ packageData }) =>
            inspectableIds.has(packageData.booking_id) &&
            packageData.buyer_inspection_status === 'PENDING',
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được danh sách kiện hàng chờ nghiệm thu.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const selectedPackage = packages.find((p) => String(p.packageData.id) === selectedPackageId);
  const selectedBooking: B2bBookingView | undefined = selectedPackage
    ? bookings.find((b) => b.id === selectedPackage.packageData.booking_id)
    : undefined;

  const awaitingConfirmation = bookings.filter(
    (b) => b.settlement && b.settlement.status !== 'RELEASED',
  );

  const handleSettleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBooking || submitting) return;

    let acceptedUnits = selectedBooking.quantity;
    let defectives = 0;

    if (choice === 'PARTIAL_DEFECT') {
      if (!Number.isInteger(defectiveQty) || defectiveQty < 1 || defectiveQty >= selectedBooking.quantity) {
        setSettlementError(
          `Số chậu lỗi phải là số nguyên từ 1 đến ${selectedBooking.quantity - 1} khi báo lỗi một phần.`,
        );
        return;
      }
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
      const res = await inspectAndSettleBookingApi(
        workspaceId,
        {
          booking_id: selectedBooking.id,
          accepted_units: acceptedUnits,
          defective_units: defectives,
          fault_party: defectives > 0 ? 'NURSERY' : 'NONE',
          note: settlementNote || undefined,
        },
        inspectKey,
      );

      setSettlementResult({
        bookingCode: res.booking.booking_code,
        settlement: res.settlement,
        record: res.settlement_record,
        balanceQr: res.balance_vietqr,
      });
      // The intent is spent: a new inspection is a new key.
      setInspectKey(newIdempotencyKey());
      setSelectedPackageId('');
      setSettlementNote('');
      setDefectiveQty(0);
      setChoice('FULL_ACCEPT');
      await loadData();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_state') {
        setSettlementError(`${err.message} Danh sách sẽ được tải lại.`);
        await loadData();
      } else {
        setSettlementError(err instanceof Error ? err.message : 'Không thể thực hiện nghiệm thu.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (confirming || confirmTarget === '') return;
    const target = bookings.find((b) => b.id === confirmTarget);
    if (!target || !target.settlement) return;
    if (target.settlement.buyer_balance_required_vnd > 0 && balanceRef.trim() === '') {
      setConfirmError('Cần mã tham chiếu giao dịch số dư đã nhận trước khi xác nhận.');
      return;
    }
    setConfirming(true);
    setConfirmError(null);
    setConfirmDone(null);
    try {
      const res = await confirmB2bSettlementApi(
        workspaceId,
        {
          booking_id: target.id,
          balance_ref: balanceRef.trim() === '' ? undefined : balanceRef.trim(),
          note: confirmNote.trim() === '' ? undefined : confirmNote.trim(),
        },
        confirmKey,
      );
      setConfirmDone(
        `Đã xác nhận đối soát đơn ${res.booking.booking_code}: trạng thái ${res.booking.status}, sổ cái đã ghi ${
          res.settlement_record.balance_collected_vnd > 0
            ? `số dư ${formatVnd(res.settlement_record.balance_collected_vnd)} đ (tham chiếu ${res.settlement_record.balance_collected_ref ?? '—'})`
            : 'không có số dư phải thu'
        }.`,
      );
      setConfirmKey(newIdempotencyKey());
      setConfirmTarget('');
      setBalanceRef('');
      setConfirmNote('');
      await loadData();
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Không thể xác nhận đối soát.');
      if (err instanceof ApiError && (err.code === 'invalid_state' || err.code === 'conflict')) {
        await loadData();
      }
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="inspection-settlement">
      <div className="panel margin-bottom-16">
        <h2 className="panel__title margin-0">
          Trạm Nghiệm Thu &amp; Đối Soát Tự Động tại Shop TP.HCM
        </h2>
        <p className="field__hint margin-0">
          Quét mã QR kiện hàng niêm phong tại Hub Sa Đéc • Đối chiếu quy cách cam kết • Số dư thanh toán qua VietQR
        </p>
        <p className="field__hint margin-0">
          Nghiệm thu chỉ <strong>tính nghĩa vụ</strong> (shop còn phải trả, vườn được nhận). Tiền chỉ được ghi sổ khi
          founder xác nhận đã nhận kèm mã tham chiếu. Sổ cái Escrow ở đây là <strong>mô phỏng</strong>: ghi nhận xác
          nhận của người, không phải báo có từ ngân hàng.
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

      {!loading && !error && packages.length === 0 && awaitingConfirmation.length === 0 && (
        <EmptyState title="Hiện tại không có kiện hàng nào cần nghiệm thu tại shop." />
      )}

      {!loading && !error && packages.length > 0 && (
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
                    aria-pressed={isSelected}
                    onClick={() => {
                      setSelectedPackageId(String(packageData.id));
                      setSettlementResult(null);
                      setSettlementError(null);
                      // A different package is a different intent.
                      setInspectKey(newIdempotencyKey());
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
              Nghiệm thu &amp; tính nghĩa vụ đối soát
            </h3>

            {selectedBooking ? (
              <form onSubmit={handleSettleSubmit}>
                <div className="sunken-card">
                  <h4 className="section-subhead margin-0">{selectedBooking.lot_name}</h4>
                  <div className="meta-grid">
                    <div>Mã đơn: <strong>{selectedBooking.booking_code}</strong></div>
                    <div>Shop nhận: <strong>{selectedBooking.buyer_shop_name}</strong></div>
                    <div>Số lượng đặt: <strong>{selectedBooking.quantity} chậu</strong></div>
                    <div>Đơn giá: <strong className="money">{formatVnd(selectedBooking.unit_price_vnd)} đ</strong></div>
                    <div>
                      Cọc đã xác nhận nhận:{' '}
                      <strong className="money">{formatVnd(selectedBooking.deposit_paid_vnd)} đ</strong>
                    </div>
                    <div>Điểm giao: {selectedBooking.destination_market}</div>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="inspection-choice">Trạng thái kiểm tra tại shop</label>
                  <select
                    id="inspection-choice"
                    value={choice}
                    onChange={(e) => setChoice(e.target.value as InspectionChoice)}
                  >
                    <option value="FULL_ACCEPT">Đạt 100% quy cách</option>
                    <option value="PARTIAL_DEFECT">Báo lỗi một phần (khuyết tật quy cách do nhà vườn)</option>
                    <option value="REJECT_ALL">Từ chối 100% do hàng hỏng/lỗi vườn</option>
                  </select>
                  <p className="field__hint">
                    Lỗi do vận chuyển chưa có quy tắc chi phí được duyệt nên chưa thể ghi nhận ở đây; ghi vào ghi chú
                    để xử lý thủ công.
                  </p>
                </div>

                {choice === 'PARTIAL_DEFECT' && (
                  <div className="field">
                    <label className="field__label" htmlFor="defective-qty">Số chậu bị lỗi (do nhà vườn)</label>
                    <input
                      id="defective-qty"
                      type="number"
                      min={1}
                      max={selectedBooking.quantity - 1}
                      step={1}
                      value={defectiveQty}
                      onChange={(e) => setDefectiveQty(Number(e.target.value))}
                    />
                  </div>
                )}

                <div className="field">
                  <label className="field__label" htmlFor="inspection-note">Ghi chú nghiệm thu</label>
                  <textarea
                    id="inspection-note"
                    value={settlementNote}
                    onChange={(e) => setSettlementNote(e.target.value)}
                    maxLength={500}
                    placeholder="VD: Nụ đều, đóng gói kỹ. 5 chậu vỡ chậu."
                  />
                </div>

                <button type="submit" className="btn" disabled={submitting} aria-busy={submitting}>
                  {submitting ? 'Đang ghi kết quả nghiệm thu...' : 'Xác nhận nghiệm thu & tính nghĩa vụ'}
                </button>
              </form>
            ) : (
              <p className="field__hint">Chọn một kiện hàng trong danh sách bên trái để nghiệm thu.</p>
            )}

            {settlementError && (
              <ErrorState title="Không thể ghi nghiệm thu">
                <p>{settlementError}</p>
              </ErrorState>
            )}
          </section>
        </div>
      )}

      {settlementResult && (
        <section className="panel margin-top-16" aria-labelledby="result-heading">
          <h3 className="panel__title" id="result-heading">
            Nghĩa vụ đối soát cho mã đơn {settlementResult.bookingCode}
          </h3>
          <SuccessState title="Đã ghi kết quả nghiệm thu. Chưa có khoản tiền nào được ghi sổ.">
            <p>{SETTLEMENT_STATUS_LABEL[settlementResult.record.status]}</p>
          </SuccessState>

          <div className="table-wrap">
            <table className="table table--spaced">
              <caption className="sr-only">Bảng nghĩa vụ đối soát cho đơn hàng này</caption>
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
                  <th scope="row">Cọc đã xác nhận nhận</th>
                  <td className="num">Đã thu</td>
                  <td className="num money">{formatVndWithUnit(settlementResult.record.deposit_paid_vnd)}</td>
                </tr>
                <tr>
                  <th scope="row">Phí sàn sẽ giữ lại khi đối soát</th>
                  <td className="num">Phải thu</td>
                  <td className="num money text-primary">
                    {formatVndWithUnit(settlementResult.settlement.platformFeeRetainedVnd)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Vườn Sa Đéc được nhận (chưa chi)</th>
                  <td className="num">Phải trả</td>
                  <td className="num money">
                    {formatVndWithUnit(settlementResult.settlement.nurseryPayoutVnd)}
                  </td>
                </tr>
                <tr className="row--highlight-primary">
                  <th scope="row" colSpan={2}>
                    Shop còn phải chuyển thêm qua VietQR (BAL) — chưa nhận
                  </th>
                  <td className="num money money--total">
                    {formatVndWithUnit(settlementResult.settlement.buyerBalanceRequiredVnd)}
                  </td>
                </tr>
                <tr>
                  <th scope="row" colSpan={2}>Tổng nghĩa vụ của shop (cọc + số dư)</th>
                  <td className="num money">
                    {formatVndWithUnit(settlementResult.settlement.buyerTotalObligationVnd)}
                  </td>
                </tr>
                {settlementResult.settlement.buyerRefundVnd > 0 && (
                  <tr className="row--highlight-danger">
                    <th scope="row" colSpan={2}>
                      Sàn phải hoàn cọc cho shop (do hàng lỗi vườn) — chưa chi
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
              <h4 className="section-subhead margin-0">Quét mã VietQR chuyển số dư còn lại:</h4>
              <div className="kv-row">
                <span>Số tiền cần chuyển:</span>
                <span className="money money--total">{formatVnd(settlementResult.balanceQr.amountVnd)} đ</span>
              </div>
              <div className="kv-row">
                <span>Nội dung chuyển khoản:</span>
                <strong className="text-primary">{settlementResult.balanceQr.transferNote}</strong>
              </div>
              <div className="qr-payload">
                {settlementResult.balanceQr.emvPayload}
              </div>
              <p className="field__hint">
                Mã QR và nội dung chuyển khoản không phải bằng chứng đã nhận tiền. Founder xác nhận sau khi thấy báo có.
              </p>
            </div>
          )}
        </section>
      )}

      {!loading && !error && awaitingConfirmation.length > 0 && (
        <section className="panel margin-top-16" aria-labelledby="confirm-heading">
          <h3 className="panel__title" id="confirm-heading">
            Đơn đã nghiệm thu, chờ xác nhận đối soát ({awaitingConfirmation.length})
          </h3>
          <div className="table-wrap">
            <table className="table table--spaced">
              <caption className="sr-only">Đơn đã nghiệm thu đang chờ founder xác nhận tiền</caption>
              <thead>
                <tr>
                  <th scope="col">Mã đơn</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col" className="num">Số dư phải thu</th>
                  <th scope="col" className="num">Vườn được nhận</th>
                  <th scope="col" className="num">Hoàn shop</th>
                </tr>
              </thead>
              <tbody>
                {awaitingConfirmation.map((b) => (
                  <tr key={b.id}>
                    <td>{b.booking_code}</td>
                    <td>{b.settlement ? SETTLEMENT_STATUS_LABEL[b.settlement.status] : '—'}</td>
                    <td className="num money">{formatVnd(b.settlement?.buyer_balance_required_vnd ?? 0)} đ</td>
                    <td className="num money">{formatVnd(b.settlement?.nursery_payout_vnd ?? 0)} đ</td>
                    <td className="num money">{formatVnd(b.settlement?.buyer_refund_vnd ?? 0)} đ</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {isFounder ? (
            <form onSubmit={handleConfirmSubmit} className="margin-top-16">
              <h4 className="section-subhead">Founder xác nhận đã nhận số dư &amp; ghi sổ cái</h4>
              <div className="field">
                <label className="field__label" htmlFor="confirm-booking">Đơn cần xác nhận</label>
                <select
                  id="confirm-booking"
                  value={confirmTarget}
                  onChange={(e) => {
                    setConfirmTarget(e.target.value);
                    setConfirmError(null);
                    setConfirmDone(null);
                    setConfirmKey(newIdempotencyKey());
                  }}
                >
                  <option value="">— Chọn đơn —</option>
                  {awaitingConfirmation.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.booking_code} — số dư {formatVnd(b.settlement?.buyer_balance_required_vnd ?? 0)} đ
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="balance-ref">Mã tham chiếu giao dịch số dư đã nhận</label>
                <input
                  id="balance-ref"
                  type="text"
                  value={balanceRef}
                  onChange={(e) => setBalanceRef(e.target.value)}
                  maxLength={64}
                  placeholder="VD: FT26102900123"
                />
                <p className="field__hint">Bắt buộc khi đơn còn số dư phải thu. Nhập đúng mã từ sao kê.</p>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="confirm-note">Ghi chú</label>
                <input
                  id="confirm-note"
                  type="text"
                  value={confirmNote}
                  onChange={(e) => setConfirmNote(e.target.value)}
                  maxLength={500}
                />
              </div>
              <button type="submit" className="btn" disabled={confirming || confirmTarget === ''} aria-busy={confirming}>
                {confirming ? 'Đang ghi sổ cái...' : 'Xác nhận đối soát & ghi sổ cái'}
              </button>
              {confirmError && (
                <ErrorState title="Không thể xác nhận đối soát">
                  <p>{confirmError}</p>
                </ErrorState>
              )}
              {confirmDone && <SuccessState title={confirmDone} />}
            </form>
          ) : (
            <p className="field__hint margin-top-16">
              Chỉ founder xác nhận đã nhận tiền. Shop chuyển số dư theo mã VietQR trên đơn; đơn sẽ chuyển sang SETTLED sau khi founder xác nhận.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
