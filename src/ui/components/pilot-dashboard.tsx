import { useState, useEffect, useCallback } from 'react';
import { fetchPilotDashboard, type PilotMetricsView } from '../api.ts';
import { formatVndWithUnit } from '../format.ts';
import { ErrorState, LoadingState } from './states.tsx';

interface PilotDashboardProps {
  workspaceId: string;
}

export function PilotDashboard({ workspaceId }: PilotDashboardProps) {
  const [metrics, setMetrics] = useState<PilotMetricsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPilotDashboard(workspaceId);
      setMetrics(res.metrics);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được chỉ số Pilot.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  return (
    <div className="pilot-dashboard">
      <div className="panel margin-bottom-16">
        <h2 className="panel__title margin-0">
          Bảng Điều Khiển Sáng Lập: Pilot 3–6 Tháng B2B Hoa Kiểng
        </h2>
        <p className="field__hint margin-0">
          Mô hình Grab Hoa Kiểng • 20–30 Vườn Sa Đéc kết nối 30–50 Shop TP.HCM • Bảo chứng Zero Outlay
        </p>
      </div>

      {loading && <LoadingState title="Đang tính toán chỉ số Pilot..." />}
      {error && (
        <ErrorState title="Lỗi tải chỉ số">
          <p>{error}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void loadMetrics()}>
            Thử lại
          </button>
        </ErrorState>
      )}

      {metrics && (
        <>
          <div className="grid grid--two grid--spaced">
            {/* KPI 1 */}
            <div className={`panel ${metrics.isNurseryGoalMet ? 'panel--wash' : ''}`}>
              <div className="kv-row--last">
                <span className="field__hint">Nhà vườn Sa Đéc xác minh</span>
                <span className={`badge ${metrics.isNurseryGoalMet ? 'badge--success' : 'badge--info'}`}>
                  {metrics.isNurseryGoalMet ? 'Đạt mục tiêu' : 'Đang mở rộng'}
                </span>
              </div>
              <p className="pilot-stat-value">
                {metrics.verifiedNurseriesCount} <span className="pilot-stat-target">/ 20–30 vườn</span>
              </p>
              <p className="field__hint margin-0">
                Các nhà vườn được kiểm định quy cách, diện tích và danh tiếng tại các ấp Tân Quy Đông, An Hòa...
              </p>
            </div>

            {/* KPI 2 */}
            <div className={`panel ${metrics.isBuyerGoalMet ? 'panel--wash' : ''}`}>
              <div className="kv-row--last">
                <span className="field__hint">Shop hoa / sỉ TP.HCM hoạt động</span>
                <span className={`badge ${metrics.isBuyerGoalMet ? 'badge--success' : 'badge--info'}`}>
                  {metrics.isBuyerGoalMet ? 'Đạt mục tiêu' : 'Đang mở rộng'}
                </span>
              </div>
              <p className="pilot-stat-value">
                {metrics.activeBuyerShopsCount} <span className="pilot-stat-target">/ 30–50 shop</span>
              </p>
              <p className="field__hint margin-0">
                Các shop hoa tươi, công ty cảnh quan tại chợ Hồ Thị Kỷ, Đầm Sen, Thủ Đức...
              </p>
            </div>

            {/* KPI 3 */}
            <div className={`panel ${metrics.isOrderVolumeGoalMet ? 'panel--wash' : ''}`}>
              <div className="kv-row--last">
                <span className="field__hint">Sản lượng đơn hoàn tất</span>
                <span className={`badge ${metrics.isOrderVolumeGoalMet ? 'badge--success' : 'badge--info'}`}>
                  {metrics.isOrderVolumeGoalMet ? 'Đạt mục tiêu' : 'Đang tích lũy'}
                </span>
              </div>
              <p className="pilot-stat-value">
                {metrics.completedBookingsCount} <span className="pilot-stat-target">/ ~100 đơn/tháng</span>
              </p>
              <p className="field__hint margin-0">
                Tổng số chuyến hàng đã qua kiểm định Hub, giao thành công và giải ngân cho nhà vườn.
              </p>
            </div>

            {/* KPI 4 */}
            <div className={`panel ${metrics.isRetentionGoalMet ? 'panel--wash' : ''}`}>
              <div className="kv-row--last">
                <span className="field__hint">Tỷ lệ đặt lại tháng 2 (Retention)</span>
                <span className={`badge ${metrics.isRetentionGoalMet ? 'badge--success' : 'badge--info'}`}>
                  {metrics.isRetentionGoalMet ? 'Đạt mục tiêu' : 'Theo dõi'}
                </span>
              </div>
              <p className="pilot-stat-value">
                {(metrics.retentionRateBps / 100).toFixed(1)}% <span className="pilot-stat-target">/ &gt;40%</span>
              </p>
              <p className="field__hint margin-0">
                Tỷ lệ shop tiếp tục đặt hàng tuần tiếp theo sau khi trải nghiệm giao nhận qua Hub Sa Đéc.
              </p>
            </div>
          </div>

          {/* Sổ Cái Invariant Card */}
          <div className="panel panel--accent-border">
            <div className="panel__header">
              <h3 className="panel__title">
                Bảo Chứng Sổ Cái Bất Biến (Zero Working Capital Outlay)
              </h3>
              <span className="badge badge--success">
                {metrics.isLedgerBalanced ? 'Tuyệt Đối Cân Bằng (100%)' : 'Cần Kiểm Tra'}
              </span>
            </div>

            <div className="grid grid--two">
              <div className="sunken-card margin-0">
                <span className="field__hint">Tiền vốn sàn phải ứng trước:</span>
                <div className="pilot-invariant-value">
                  {formatVndWithUnit(metrics.totalPlatformOutlayVnd)}
                </div>
                <p className="field__hint margin-0">
                  Bảo đảm sàn không phải bỏ vốn lưu động mua đứt hoa kiểng; mọi dòng tiền đều vận hành qua Escrow cọc của shop.
                </p>
              </div>

              <div className="sunken-card margin-0">
                <span className="field__hint">Số đơn có chênh lệch dòng tiền:</span>
                <div className="pilot-invariant-value">
                  {metrics.unbalancedSettledBookingsCount} đơn
                </div>
                <p className="field__hint margin-0">
                  Khớp tuyệt đối phương trình: Tiền shop trả = Tiền giải ngân vườn + Tiền hoàn shop + Phí sàn giữ lại.
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
