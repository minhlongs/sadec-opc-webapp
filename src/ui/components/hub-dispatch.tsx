import { useState, useEffect, useCallback } from 'react';
import {
  fetchHubTrips,
  verifyHubPackageApi,
  type HubDispatchTripView,
} from '../api.ts';
import { EmptyState, ErrorState, LoadingState, SuccessState } from './states.tsx';

interface HubDispatchProps {
  workspaceId: string;
  role: string;
}

export function HubDispatch({ workspaceId, role }: HubDispatchProps) {
  const [trips, setTrips] = useState<HubDispatchTripView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Package Verification Form
  const [selectedTripId, setSelectedTripId] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [packageLabel, setPackageLabel] = useState('');
  const [hubNote, setHubNote] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifySuccess, setVerifySuccess] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const loadTrips = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchHubTrips(workspaceId);
      setTrips(res.trips);
      const firstTrip = res.trips[0];
      if (firstTrip !== undefined && !selectedTripId) {
        setSelectedTripId(firstTrip.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được danh sách chuyến xe Hub.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedTripId]);

  useEffect(() => {
    void loadTrips();
  }, [loadTrips]);

  const handleVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTripId || !bookingId || !packageLabel) return;
    setVerifying(true);
    setVerifyError(null);
    setVerifySuccess(null);

    try {
      const res = await verifyHubPackageApi(workspaceId, {
        trip_id: selectedTripId,
        booking_id: bookingId,
        package_label: packageLabel,
        hub_note: hubNote || undefined,
      });

      setVerifySuccess(`Đã kiểm định & cấp mã QR kiện hàng ${res.package.package_label} thành công!`);
      setBookingId('');
      setPackageLabel('');
      setHubNote('');
      await loadTrips();
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Kiểm định kiện hàng thất bại.');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="hub-dispatch">
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title" style={{ margin: '0 0 4px' }}>
          Điều Phối Gom Hàng & Cross-docking Hub Sa Đéc
        </h2>
        <p className="field__hint" style={{ margin: 0 }}>
          Tập trung hàng từ các nhà vườn • Kiểm định quy cách & niêm phong mã QR HMAC • Xếp chuyến xe tải đêm về TP.HCM
        </p>
      </div>

      {role === 'founder_admin' && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>
            Trạm Kiểm Định Quy Cách & Dán Mã QR Kiện Hàng Tại Hub
          </h3>

          {verifySuccess && <SuccessState title={verifySuccess} />}
          {verifyError && <p className="field__error">{verifyError}</p>}

          <form onSubmit={handleVerifySubmit} className="grid grid--two" style={{ marginTop: 12 }}>
            <div className="field">
              <label className="field__label">Chuyến xe ghép</label>
              <select value={selectedTripId} onChange={(e) => setSelectedTripId(e.target.value)}>
                {trips.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.trip_code} ({t.truck_plate}) - Đi {t.destination_market}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label">Mã đơn hàng cần nhập Hub (booking_id)</label>
              <input
                required
                value={bookingId}
                onChange={(e) => setBookingId(e.target.value)}
                placeholder="VD: bk-1001 hoặc mã UUID đơn"
              />
            </div>

            <div className="field">
              <label className="field__label">Nhãn niêm phong kiện hàng</label>
              <input
                required
                value={packageLabel}
                onChange={(e) => setPackageLabel(e.target.value)}
                placeholder="VD: KIỆN #01 - 50 CHẬU CÚC - SHOP THÁNG NĂM"
              />
            </div>

            <div className="field">
              <label className="field__label">Ghi chú kiểm định thực tế tại Hub</label>
              <input
                value={hubNote}
                onChange={(e) => setHubNote(e.target.value)}
                placeholder="Cây khỏe, nụ đều, đóng bọc lưới an toàn"
              />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <button type="submit" className="btn" disabled={verifying}>
                {verifying ? 'Đang tạo mã QR...' : 'Xác nhận đạt chuẩn Hub & Cấp mã QR kiện hàng'}
              </button>
            </div>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <div>
                <span className="role" style={{ background: '#e6efea', color: '#0f4a38', marginRight: 8 }}>
                  {trip.status}
                </span>
                <strong style={{ fontSize: 16 }}>{trip.trip_code}</strong> — Biển số: <strong>{trip.truck_plate}</strong>
              </div>
              <div className="field__hint">
                Tài xế: <strong>{trip.driver_name}</strong> ({trip.driver_phone})
              </div>
            </div>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', background: 'var(--surface-sunken)', padding: 12, borderRadius: 'var(--radius-small)', marginBottom: 16 }}>
              <div>Xuất bến Sa Đéc: <strong>{new Date(trip.departure_sa_dec_at).toLocaleTimeString('vi-VN')} ({new Date(trip.departure_sa_dec_at).toLocaleDateString('vi-VN')})</strong></div>
              <div>Dự kiến đến TP.HCM: <strong>{new Date(trip.eta_hcm_at).toLocaleTimeString('vi-VN')}</strong></div>
              <div>Điểm trả hàng: <strong>{trip.destination_market}</strong></div>
              <div>Tải trọng: <strong>{trip.loaded_units} / {trip.capacity_units} chậu</strong></div>
            </div>

            <h4 style={{ fontSize: 14, margin: '0 0 8px', fontWeight: 700 }}>
              Các kiện hàng đã kiểm định trên chuyến xe ({trip.packages?.length ?? 0}):
            </h4>

            {(!trip.packages || trip.packages.length === 0) ? (
              <p className="field__hint">Chưa có kiện hàng nào được xếp lên chuyến xe này.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Nhãn kiện hàng</th>
                    <th>Shop nhận</th>
                    <th className="num">Số lượng</th>
                    <th>Trạng thái Hub</th>
                    <th>Mã QR niêm phong</th>
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
                        <span className="role" style={{ fontSize: 11 }}>{pkg.hub_inspection_status}</span>
                      </td>
                      <td>
                        <code style={{ fontSize: 11, background: 'var(--surface-sunken)', padding: '2px 4px', borderRadius: 4 }}>
                          {pkg.package_qr_token.slice(0, 24)}...
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
