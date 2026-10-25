import { useState, useEffect, useCallback } from 'react';
import { fetchPilotDashboard, type PilotMetricsView } from '../api.ts';
import { formatVndWithUnit } from '../format.ts';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';

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
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title" style={{ margin: '0 0 4px' }}>
          Bảng Điều Khiển Sáng Lập: Pilot 3–6 Tháng B2B Hoa Kiểng
        </h2>
        <p className="field__hint" style={{ margin: 0 }}>
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
          <div className="grid grid--two" style={{ marginBottom: 16 }}>
            {/* KPI 1 */}
            <div className="panel" style={{ background: metrics.isNurseryGoalMet ? 'var(--primary-wash)' : 'var(--surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="field__hint">Nhà vườn Sa Đéc xác minh</span>
                <span className="role">{metrics.isNurseryGoalMet ? 'Đạt mục tiêu' : 'Đang mở rộng'}</span>
              </div>
              <p style={{ fontSize: 32, fontWeight: 700, margin: '8px 0 4px', color: 'var(--primary-strong)' }}>
                {metrics.verifiedNurseriesCount} <span style={{ fontSize: 16, fontWeight: 400 }}>/ 20–30 vườn</span>
              </p>
              <p className="field__hint" style={{ margin: 0 }}>
                Các nhà vườn được kiểm định quy cách, diện tích và danh tiếng tại các ấp Tân Quy Đông, An Hòa...
              </p>
            </div>

            {/* KPI 2 */}
            <div className="panel" style={{ background: metrics.isBuyerGoalMet ? 'var(--primary-wash)' : 'var(--surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="field__hint">Shop hoa / sỉ TP.HCM hoạt động</span>
                <span className="role">{metrics.isBuyerGoalMet ? 'Đạt mục tiêu' : 'Đang mở rộng'}</span>
              </div>
              <p style={{ fontSize: 32, fontWeight: 700, margin: '8px 0 4px', color: 'var(--primary-strong)' }}>
                {metrics.activeBuyerShopsCount} <span style={{ fontSize: 16, fontWeight: 400 }}>/ 30–50 shop</span>
              </p>
              <p className="field__hint" style={{ margin: 0 }}>
                Các shop hoa tươi, công ty cảnh quan tại chợ Hồ Thị Kỷ, Đầm Sen, Thủ Đức...
              </p>
            </div>

            {/* KPI 3 */}
            <div className="panel" style={{ background: metrics.isOrderVolumeGoalMet ? 'var(--primary-wash)' : 'var(--surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="field__hint">Sản lượng đơn hoàn tất</span>
                <span className="role">{metrics.isOrderVolumeGoalMet ? 'Đạt mục tiêu' : 'Đang tích lũy'}</span>
              </div>
              <p style={{ fontSize: 32, fontWeight: 700, margin: '8px 0 4px', color: 'var(--primary-strong)' }}>
                {metrics.completedBookingsCount} <span style={{ fontSize: 16, fontWeight: 400 }}>/ ~100 đơn/tháng</span>
              </p>
              <p className="field__hint" style={{ margin: 0 }}>
                Tổng số chuyến hàng đã qua kiểm định Hub, giao thành công và giải ngân cho nhà vườn.
              </p>
            </div>

            {/* KPI 4 */}
            <div className="panel" style={{ background: metrics.isRetentionGoalMet ? 'var(--primary-wash)' : 'var(--surface)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="field__hint">Tỷ lệ đặt lại tháng 2 (Retention)</span>
                <span className="role">{metrics.isRetentionGoalMet ? 'Đạt mục tiêu' : 'Theo dõi'}</span>
              </div>
              <p style={{ fontSize: 32, fontWeight: 700, margin: '8px 0 4px', color: 'var(--primary-strong)' }}>
                {(metrics.retentionRateBps / 100).toFixed(1)}% <span style={{ fontSize: 16, fontWeight: 400 }}>/ &gt;40%</span>
              </p>
              <p className="field__hint" style={{ margin: 0 }}>
                Tỷ lệ shop tiếp tục đặt hàng tuần tiếp theo sau khi trải nghiệm giao nhận qua Hub Sa Đéc.
              </p>
            </div>
          </div>

          {/* Sổ Cái Invariant Card */}
          <div className="panel" style={{ border: '2px solid var(--primary-strong)' }}>
            <h3 className="panel__title" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
              <span>Bảo Chứng Sổ Cái Bất Biến (Zero Working Capital Outlay)</span>
              <span className="role" style={{ background: '#e6efea', color: '#0f4a38', borderColor: '#0f4a38' }}>
                {metrics.isLedgerBalanced ? 'Tuyệt Đối Cân Bằng (100%)' : 'Cần Kiểm Tra'}
              </span>
            </h3>

            <div className="grid grid--two">
              <div style={{ background: 'var(--surface-sunken)', padding: 12, borderRadius: 'var(--radius-small)' }}>
                <span className="field__hint">Tiền vốn sàn phải ứng trước:</span>
                <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--primary-strong)' }}>
                  {formatVndWithUnit(metrics.totalPlatformOutlayVnd)}
                </div>
                <p className="field__hint" style={{ margin: '4px 0 0' }}>
                  Bảo đảm sàn không phải bỏ vốn lưu động mua đứt hoa kiểng; mọi dòng tiền đều vận hành qua Escrow cọc của shop.
                </p>
              </div>

              <div style={{ background: 'var(--surface-sunken)', padding: 12, borderRadius: 'var(--radius-small)' }}>
                <span className="field__hint">Số đơn có chênh lệch dòng tiền:</span>
                <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--primary-strong)' }}>
                  {metrics.unbalancedSettledBookingsCount} đơn
                </div>
                <p className="field__hint" style={{ margin: '4px 0 0' }}>
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
