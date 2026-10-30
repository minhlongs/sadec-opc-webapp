import { useState, useEffect, useCallback } from 'react';
import {
  ApiError,
  createHubTripApi,
  fetchB2bBookings,
  fetchHubTrips,
  newIdempotencyKey,
  verifyHubPackageApi,
  type B2bBookingView,
  type HubDispatchTripView,
} from '../api.ts';
import { EmptyState, ErrorState, LoadingState, SuccessState } from './states.tsx';

/** Local datetime-local value → ISO string, or null when unparseable. */
function toIso(local: string): string | null {
  if (local.trim() === '') return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

interface HubDispatchProps {
  workspaceId: string;
  role: string;
}

export function HubDispatch({ workspaceId, role }: HubDispatchProps) {
  const [trips, setTrips] = useState<HubDispatchTripView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Bookings the founder may load: ESCROW_HELD ones visible from this workspace.
  const [loadable, setLoadable] = useState<B2bBookingView[]>([]);

  // Package Verification Form
  const [selectedTripId, setSelectedTripId] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [packageLabel, setPackageLabel] = useState('');
  const [hubNote, setHubNote] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifySuccess, setVerifySuccess] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyKey, setVerifyKey] = useState<string>(() => newIdempotencyKey());

  // New Trip Form
  const [tripOpen, setTripOpen] = useState(false);
  const [truckPlate, setTruckPlate] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [departureAt, setDepartureAt] = useState('');
  const [etaAt, setEtaAt] = useState('');
  const [destination, setDestination] = useState('Chợ hoa Hồ Thị Kỷ, Quận 10');
  const [capacity, setCapacity] = useState<number>(250);
  const [creatingTrip, setCreatingTrip] = useState(false);
  const [tripError, setTripError] = useState<string | null>(null);
  const [tripSuccess, setTripSuccess] = useState<string | null>(null);
  const [tripKey, setTripKey] = useState<string>(() => newIdempotencyKey());

  const isFounder = role === 'founder_admin';

  const loadTrips = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchHubTrips(workspaceId);
      setTrips(res.trips);
      setSelectedTripId((current) => {
        if (current !== '' && res.trips.some((t) => t.id === current)) return current;
        const open = res.trips.find((t) => t.status === 'GATHERING') ?? res.trips[0];
        return open?.id ?? '';
      });
      if (isFounder) {
        const bookings = await fetchB2bBookings(workspaceId);
        setLoadable(bookings.bookings.filter((b) => b.status === 'ESCROW_HELD'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được danh sách chuyến xe Hub.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, isFounder]);

  useEffect(() => {
    void loadTrips();
  }, [loadTrips]);

  const handleVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (verifying) return;
    if (!selectedTripId || !bookingId.trim() || !packageLabel.trim()) {
      setVerifyError('Cần chọn chuyến xe, mã đơn hàng và nhãn kiện hàng.');
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    setVerifySuccess(null);

    try {
      const res = await verifyHubPackageApi(
        workspaceId,
        {
          trip_id: selectedTripId,
          booking_id: bookingId.trim(),
          package_label: packageLabel.trim(),
          hub_note: hubNote || undefined,
        },
        verifyKey,
      );

      setVerifySuccess(`Đã kiểm định & cấp mã QR kiện hàng ${res.package.package_label} (${res.package.units_count} chậu).`);
      // The intent is spent; the form keeps nothing of it.
      setVerifyKey(newIdempotencyKey());
      setBookingId('');
      setPackageLabel('');
      setHubNote('');
      await loadTrips();
    } catch (err) {
      // The form content stays so the person can correct and resend with the
      // same key — unless the server says the state moved on, in which case
      // the list is stale and is reloaded.
      setVerifyError(err instanceof Error ? err.message : 'Kiểm định kiện hàng thất bại.');
      if (err instanceof ApiError && (err.code === 'invalid_state' || err.code === 'conflict')) {
        await loadTrips();
      }
    } finally {
      setVerifying(false);
    }
  };

  const handleCreateTrip = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingTrip) return;
    const departureIso = toIso(departureAt);
    const etaIso = toIso(etaAt);
    if (departureIso === null || etaIso === null) {
      setTripError('Cần nhập giờ xuất bến và giờ dự kiến đến hợp lệ.');
      return;
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      setTripError('Sức chứa phải là số nguyên dương.');
      return;
    }
    setCreatingTrip(true);
    setTripError(null);
    setTripSuccess(null);
    try {
      const res = await createHubTripApi(
        workspaceId,
        {
          truck_plate: truckPlate.trim(),
          driver_name: driverName.trim(),
          driver_phone: driverPhone.trim(),
          departure_sa_dec_at: departureIso,
          eta_hcm_at: etaIso,
          destination_market: destination.trim(),
          capacity_units: capacity,
        },
        tripKey,
      );
      setTripSuccess(`Đã mở chuyến ${res.trip.trip_code} (${res.trip.truck_plate}, sức chứa ${res.trip.capacity_units} chậu).`);
      setTripKey(newIdempotencyKey());
      setTruckPlate('');
      setDriverName('');
      setDriverPhone('');
      setDepartureAt('');
      setEtaAt('');
      setTripOpen(false);
      await loadTrips();
      setSelectedTripId(res.trip.id);
    } catch (err) {
      setTripError(err instanceof Error ? err.message : 'Không mở được chuyến xe.');
    } finally {
      setCreatingTrip(false);
    }
  };

  return (
    <div className="hub-dispatch">
      <div className="panel margin-bottom-16">
        <h2 className="panel__title margin-0">
          Điều Phối Gom Hàng &amp; Cross-docking Hub Sa Đéc
        </h2>
        <p className="field__hint margin-0">
          Tập trung hàng từ các nhà vườn • Kiểm định quy cách &amp; niêm phong mã QR HMAC • Xếp chuyến xe tải đêm về TP.HCM
        </p>
      </div>

      {isFounder && (
        <div className="panel margin-bottom-16">
          <div className="panel__header">
            <h3 className="section-subhead margin-0">Mở chuyến xe ghép đêm</h3>
            <button
              type="button"
              className="btn btn--secondary"
              aria-expanded={tripOpen}
              onClick={() => {
                setTripOpen((open) => !open);
                setTripError(null);
              }}
            >
              {tripOpen ? 'Đóng biểu mẫu' : '+ Chuyến xe mới'}
            </button>
          </div>
          {tripSuccess && <SuccessState title={tripSuccess} />}
          {tripOpen && (
            <form onSubmit={handleCreateTrip} className="grid grid--two grid--top-spaced">
              <div className="field">
                <label className="field__label" htmlFor="trip-plate">Biển số xe</label>
                <input id="trip-plate" required value={truckPlate} onChange={(e) => setTruckPlate(e.target.value)} placeholder="66C-123.45" />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="trip-driver">Tài xế</label>
                <input id="trip-driver" required value={driverName} onChange={(e) => setDriverName(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="trip-phone">Điện thoại tài xế</label>
                <input id="trip-phone" required value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} inputMode="tel" />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="trip-capacity">Sức chứa (chậu)</label>
                <input
                  id="trip-capacity"
                  type="number"
                  min={1}
                  step={1}
                  required
                  value={capacity}
                  onChange={(e) => setCapacity(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="trip-departure">Xuất bến Sa Đéc</label>
                <input id="trip-departure" type="datetime-local" required value={departureAt} onChange={(e) => setDepartureAt(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="trip-eta">Dự kiến đến TP.HCM</label>
                <input id="trip-eta" type="datetime-local" required value={etaAt} onChange={(e) => setEtaAt(e.target.value)} />
              </div>
              <div className="field span-full">
                <label className="field__label" htmlFor="trip-destination">Điểm trả hàng</label>
                <input id="trip-destination" required value={destination} onChange={(e) => setDestination(e.target.value)} />
              </div>
              <div className="span-full">
                <button type="submit" className="btn" disabled={creatingTrip} aria-busy={creatingTrip}>
                  {creatingTrip ? 'Đang mở chuyến...' : 'Mở chuyến xe'}
                </button>
              </div>
              {tripError && (
                <div className="span-full">
                  <ErrorState title="Không mở được chuyến xe">
                    <p>{tripError}</p>
                  </ErrorState>
                </div>
              )}
            </form>
          )}
        </div>
      )}

      {isFounder && (
        <div className="panel margin-bottom-16">
          <h3 className="section-subhead margin-0">
            Trạm Kiểm Định Quy Cách &amp; Dán Mã QR Kiện Hàng Tại Hub
          </h3>

          {verifySuccess && <SuccessState title={verifySuccess} />}

          <form onSubmit={handleVerifySubmit} className="grid grid--two grid--top-spaced">
            <div className="field">
              <label className="field__label" htmlFor="verify-trip">Chuyến xe ghép</label>
              <select id="verify-trip" value={selectedTripId} onChange={(e) => setSelectedTripId(e.target.value)}>
                {trips.length === 0 && <option value="">— Chưa có chuyến —</option>}
                {trips.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.status !== 'GATHERING'}>
                    {t.trip_code} ({t.truck_plate}) — {t.destination_market} — {t.loaded_units}/{t.capacity_units} chậu
                    {t.status !== 'GATHERING' ? ` — ${t.status}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="verify-booking">Đơn hàng cần nhập Hub (đã xác nhận cọc)</label>
              <select
                id="verify-booking"
                required
                value={bookingId}
                onChange={(e) => {
                  setBookingId(e.target.value);
                  setVerifyError(null);
                  setVerifyKey(newIdempotencyKey());
                }}
              >
                <option value="">— Chọn đơn —</option>
                {loadable.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.booking_code} — {b.buyer_shop_name} — {b.quantity} chậu {b.lot_name ?? ''}
                  </option>
                ))}
              </select>
              {loadable.length === 0 && (
                <p className="field__hint">Chưa có đơn nào ở trạng thái đã giữ cọc trong không gian này.</p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="verify-label">Nhãn niêm phong kiện hàng</label>
              <input
                id="verify-label"
                required
                value={packageLabel}
                onChange={(e) => setPackageLabel(e.target.value)}
                placeholder="VD: KIỆN #01 - 50 CHẬU CÚC - SHOP THÁNG NĂM"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="verify-note">Ghi chú kiểm định thực tế tại Hub</label>
              <input
                id="verify-note"
                value={hubNote}
                onChange={(e) => setHubNote(e.target.value)}
                placeholder="Cây khỏe, nụ đều, đóng bọc lưới an toàn"
              />
            </div>

            <div className="span-full">
              <button type="submit" className="btn" disabled={verifying} aria-busy={verifying}>
                {verifying ? 'Đang tạo mã QR...' : 'Xác nhận đạt chuẩn Hub & Cấp mã QR kiện hàng'}
              </button>
            </div>
            {verifyError && (
              <div className="span-full">
                <ErrorState title="Kiểm định kiện hàng thất bại">
                  <p>{verifyError}</p>
                </ErrorState>
              </div>
            )}
          </form>
        </div>
      )}

      {loading && <LoadingState title="Đang tải danh sách chuyến xe..." />}
      {error && (
        <ErrorState title="Lỗi tải dữ liệu">
          <p>{error}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void loadTrips()}>
            Thử lại
          </button>
        </ErrorState>
      )}

      {!loading && !error && trips.length === 0 && (
        <EmptyState title="Chưa có chuyến xe ghép nào được điều phối." />
      )}

      <div className="grid">
        {trips.map((trip) => (
          <div key={trip.id} className="panel">
            <div className="panel__header">
              <div>
                <span className="badge badge--success badge--spaced-right">
                  {trip.status}
                </span>
                <strong className="trip-title">{trip.trip_code}</strong> — Biển số: <strong>{trip.truck_plate}</strong>
              </div>
              <div className="field__hint">
                Tài xế: <strong>{trip.driver_name}</strong> ({trip.driver_phone})
              </div>
            </div>

            <div className="sunken-meta-row">
              <div>Xuất bến Sa Đéc: <strong>{new Date(trip.departure_sa_dec_at).toLocaleTimeString('vi-VN')} ({new Date(trip.departure_sa_dec_at).toLocaleDateString('vi-VN')})</strong></div>
              <div>Dự kiến đến TP.HCM: <strong>{new Date(trip.eta_hcm_at).toLocaleTimeString('vi-VN')}</strong></div>
              <div>Điểm trả hàng: <strong>{trip.destination_market}</strong></div>
              <div>Tải trọng: <strong>{trip.loaded_units} / {trip.capacity_units} chậu</strong></div>
            </div>

            <h4 className="section-subhead margin-bottom-8">
              Các kiện hàng đã kiểm định trên chuyến xe ({trip.packages?.length ?? 0}):
            </h4>

            {(!trip.packages || trip.packages.length === 0) ? (
              <p className="field__hint">Chưa có kiện hàng nào được xếp lên chuyến xe này.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Nhãn kiện hàng</th>
                      <th scope="col">Shop nhận</th>
                      <th scope="col" className="num">Số lượng</th>
                      <th scope="col">Trạng thái Hub</th>
                      <th scope="col">Mã QR niêm phong</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trip.packages.map((pkg) => (
                      <tr key={pkg.id}>
                        <td>
                          <strong>{pkg.package_label}</strong>
                          {pkg.hub_note && <div className="field__hint">{pkg.hub_note}</div>}
                        </td>
                        <td>{pkg.buyer_shop_name ?? 'Shop TP.HCM'}</td>
                        <td className="num">{pkg.units_count} chậu</td>
                        <td>
                          <span className="badge badge--info">{pkg.hub_inspection_status}</span>
                        </td>
                        <td>
                          <code className="code-chip">
                            {pkg.package_qr_token.slice(0, 24)}...
                          </code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
