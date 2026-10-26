/**
 * Phase 3 — Founder Area UI:
 * 1. Interviews & append-only Observations (+ CSV/JSON export)
 * 2. Change Proposals & Immutable Config Versions (+ Rollback)
 * 3. OPC Unit Economics Scenarios (N=5, N=10, N=10/S=2, separated from actuals)
 * 4. OPC Commercial Ledger (Agreements, Obligations, OPC Receipts, Pilot Credits)
 */

import { useCallback, useEffect, useState } from 'react';
import {
  applyFounderProposalApi,
  createFounderProposalApi,
  fetchFounderConfig,
  fetchFounderEconomics,
  fetchFounderInterviews,
  fetchFounderOpcLedger,
  rollbackFounderConfigApi,
  type ChangeProposalView,
  type ConfigVersionView,
  type FounderEconomicsResponse,
  type FounderInterviewView,
  type FounderObservationView,
  type OpcLedgerResponse,
} from '../api.ts';
import { formatTimestamp, formatVndWithUnit } from '../format.ts';
import { EmptyState, ErrorState, LoadingState, SuccessState } from './states.tsx';

export interface FounderScreenProps {
  workspaceId: string;
}

function founderBadgeClass(status: string): string {
  switch (status) {
    case 'applied':
    case 'paid':
    case 'real':
    case 'measured':
    case 'observed':
      return 'badge badge--success';
    case 'reported':
    case 'inferred':
    case 'open':
      return 'badge badge--info';
    case 'draft':
    case 'synthetic':
      return 'badge badge--warning';
    case 'rejected':
    case 'overdue':
      return 'badge badge--danger';
    default:
      return 'badge';
  }
}

export function FounderScreen({ workspaceId }: FounderScreenProps) {
  const [interviews, setInterviews] = useState<FounderInterviewView[]>([]);
  const [observations, setObservations] = useState<FounderObservationView[]>([]);
  const [activeVersion, setActiveVersion] = useState<ConfigVersionView | null>(null);
  const [versions, setVersions] = useState<ConfigVersionView[]>([]);
  const [proposals, setProposals] = useState<ChangeProposalView[]>([]);
  const [economics, setEconomics] = useState<FounderEconomicsResponse | null>(null);
  const [opcLedger, setOpcLedger] = useState<OpcLedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Proposal form state
  const [metricKey, setMetricKey] = useState('support_hours_per_customer_month');
  const [metricValue, setMetricValue] = useState('3');
  const [rationale, setRationale] = useState('');
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [intData, cfgData, econData, ledgerData] = await Promise.all([
        fetchFounderInterviews(workspaceId),
        fetchFounderConfig(workspaceId),
        fetchFounderEconomics(workspaceId),
        fetchFounderOpcLedger(workspaceId),
      ]);
      setInterviews(intData.interviews);
      setObservations(intData.observations);
      setActiveVersion(cfgData.active_version);
      setVersions(cfgData.versions);
      setProposals(cfgData.proposals);
      setEconomics(econData);
      setOpcLedger(ledgerData);
      if (intData.observations.length > 0 && selectedEvidenceId === '') {
        setSelectedEvidenceId(intData.observations[0]?.id ?? '');
      }
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'Không tải được dữ liệu Sáng lập.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedEvidenceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreateProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const numVal = Number(metricValue);
      if (!Number.isFinite(numVal) || numVal < 0) {
        setActionError('Giá trị tham số phải là số hợp lệ không âm.');
        return;
      }
      await createFounderProposalApi(workspaceId, {
        scope: 'business_model',
        base_version_id: activeVersion?.id ?? null,
        changes: { [metricKey]: numVal },
        evidence_ids: selectedEvidenceId ? [selectedEvidenceId] : [],
        rationale: rationale.trim() || 'Cập nhật tham số từ quan sát thực địa',
      });
      setRationale('');
      setActionNotice('Đã tạo đề xuất thay đổi cấu hình mới.');
      await reload();
    } catch (thrown) {
      setActionError(thrown instanceof Error ? thrown.message : 'Không tạo được đề xuất.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApplyProposal = async (proposalId: string) => {
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await applyFounderProposalApi(workspaceId, proposalId);
      setActionNotice(`Đã áp dụng đề xuất → Phiên bản v${res.version.version_number}`);
      await reload();
    } catch (thrown) {
      setActionError(thrown instanceof Error ? thrown.message : 'Không áp dụng được đề xuất.');
    }
  };

  const handleRollback = async (targetVersionId: string) => {
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await rollbackFounderConfigApi(workspaceId, targetVersionId);
      setActionNotice(`Đã khôi phục cấu hình → Phiên bản mới v${res.version.version_number}`);
      await reload();
    } catch (thrown) {
      setActionError(thrown instanceof Error ? thrown.message : 'Không khôi phục được phiên bản.');
    }
  };

  if (loading && economics === null) {
    return <LoadingState title="Đang tải phân hệ Sáng lập (Discovery, Kinh tế OPC & Sổ cái)…" />;
  }

  if (error !== null && economics === null) {
    return (
      <ErrorState title="Không tải được phân hệ Sáng lập">
        <p>{error}</p>
        <button type="button" className="btn btn--secondary" onClick={() => void reload()}>
          Thử lại
        </button>
      </ErrorState>
    );
  }

  return (
    <div className="grid grid--two" data-testid="founder-screen">
      <nav aria-label="Pipeline phân hệ sáng lập" className="stepper-bar">
        <span className="stepper-bar__title">Pipeline Sáng Lập</span>
        <a className="stepper-bar__item" href="#founder-economics">
          <span className="stepper-bar__step-num">1</span>
          Kinh tế OPC
        </a>
        <a className="stepper-bar__item" href="#founder-interviews">
          <span className="stepper-bar__step-num">2</span>
          Phỏng vấn
        </a>
        <a className="stepper-bar__item" href="#founder-config">
          <span className="stepper-bar__step-num">3</span>
          Phiên bản cấu hình
        </a>
        <a className="stepper-bar__item" href="#founder-opc">
          <span className="stepper-bar__step-num">4</span>
          Sổ cáng thương mại OPC
        </a>
      </nav>

      {actionNotice !== null && (
        <div className="span-full">
          <SuccessState title={actionNotice} />
        </div>
      )}
      {actionError !== null && (
        <div className="span-full">
          <ErrorState title="Thao tác từ chối">
            <p>{actionError}</p>
          </ErrorState>
        </div>
      )}

      {/* 1. Economics Scenarios */}
      <section className="panel span-full" id="founder-economics" aria-labelledby="econ-heading">
        <div className="panel__header">
          <h2 className="panel__title" id="econ-heading">
            Kinh Tế Đơn Vị OPC &amp; Kịch Bản Công Suất (N=5, N=10, N=10/S=2)
          </h2>
          <span className="badge badge--warning" data-testid="scenario-simulation-badge">
            {economics?.label ?? 'SCENARIO_SIMULATION'}
          </span>
        </div>

        {economics !== null && (
          <table className="table table--spaced">
            <thead>
              <tr>
                <th scope="col">Kịch bản (N khách / S cài đặt mới)</th>
                <th scope="col" className="num">Doanh thu tháng</th>
                <th scope="col" className="num">Chi phí tiền mặt</th>
                <th scope="col" className="num">Lợi nhuận vận hành</th>
                <th scope="col" className="num">Giờ công (Còn lại)</th>
                <th scope="col" className="num">Lợi nhuận kinh tế</th>
                <th scope="col" className="num">Giá sàn Pilot</th>
              </tr>
            </thead>
            <tbody>
              {economics.scenarios.map((sc, idx) => (
                <tr key={idx} className={sc.capacityExhausted ? 'row--highlight-danger' : undefined}>
                  <td>
                    <strong>N={sc.activeCustomers}, S={sc.newSetupsInMonth}</strong>
                    {sc.capacityExhausted && (
                      <div className="field__hint text-danger">
                        Vượt trần 160h/tháng
                      </div>
                    )}
                  </td>
                  <td className="num money">{formatVndWithUnit(sc.monthlyRevenueVnd)}</td>
                  <td className="num money">{formatVndWithUnit(sc.cashCostVnd)}</td>
                  <td className="num money">{formatVndWithUnit(sc.operatingProfitVnd)}</td>
                  <td className="num">
                    {sc.founderHoursUsed}h ({sc.remainingHours}h)
                  </td>
                  <td className="num money">{formatVndWithUnit(sc.economicProfitVnd)}</td>
                  <td className="num money">{formatVndWithUnit(sc.minimumPilotPriceVnd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 2. Interviews & Observations */}
      <section className="panel" id="founder-interviews" aria-labelledby="interviews-heading">
        <div className="panel__header">
          <h2 className="panel__title" id="interviews-heading">
            Phỏng Vấn &amp; Quan Sát Thực Địa ({interviews.length})
          </h2>
          <a
            className="btn btn--secondary btn--small"
            href={`/api/founder/interviews/export?workspace_id=${encodeURIComponent(workspaceId)}&format=csv`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Xuất CSV
          </a>
        </div>

        {interviews.length === 0 ? (
          <EmptyState title="Chưa có dữ liệu phỏng vấn" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Mã</th>
                <th scope="col">Đơn vị / Vai trò</th>
                <th scope="col">Nguồn</th>
                <th scope="col">Bản sửa</th>
              </tr>
            </thead>
            <tbody>
              {interviews.map((iv) => (
                <tr key={iv.id}>
                  <td>{iv.external_id}</td>
                  <td>
                    <strong>{iv.organization_alias}</strong>
                    <div className="field__hint">{iv.respondent_role} ({iv.interviewed_at})</div>
                  </td>
                  <td>
                    <span className={founderBadgeClass(iv.data_origin === 'synthetic' ? 'synthetic' : 'real')}>
                      {iv.data_origin === 'synthetic' ? 'MẪU (Synthetic)' : 'Thực tế'}
                    </span>
                  </td>
                  <td>v{iv.revision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 className="section-subhead">
          Quan sát định lượng ({observations.length})
        </h3>
        {observations.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Chỉ số</th>
                <th scope="col" className="num">Giá trị</th>
                <th scope="col">Loại bằng chứng</th>
              </tr>
            </thead>
            <tbody>
              {observations.map((obs) => (
                <tr key={obs.id}>
                  <td>
                    {obs.metric_key}
                    <div className="field__hint">{obs.source_ref ?? ''}</div>
                  </td>
                  <td className="num">
                    {obs.is_null === 1
                      ? 'Chưa rõ (NULL)'
                      : `${obs.value_num ?? obs.value_str ?? ''} ${obs.unit}`}
                  </td>
                  <td>
                    <span className={founderBadgeClass(obs.evidence_kind)}>{obs.evidence_kind}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 3. Config Proposals & Versions */}
      <section className="panel" id="founder-config" aria-labelledby="config-heading">
        <h2 className="panel__title" id="config-heading">
          Đề Xuất Thay Đổi &amp; Phiên Bản Cấu Hình (Đang chạy: v{activeVersion?.version_number ?? 1})
        </h2>

        <form onSubmit={(e) => void handleCreateProposal(e)} className="form-block">
          <div className="field">
            <label className="field__label" htmlFor="founder-metric-key">
              Tham số muốn điều chỉnh
            </label>
            <select
              id="founder-metric-key"
              value={metricKey}
              onChange={(e) => setMetricKey(e.target.value)}
            >
              <option value="support_hours_per_customer_month">support_hours_per_customer_month</option>
              <option value="setup_hours_per_customer">setup_hours_per_customer</option>
              <option value="pilot_fee_vnd">pilot_fee_vnd</option>
              <option value="setup_fee_vnd">setup_fee_vnd</option>
              <option value="monthly_fee_vnd">monthly_fee_vnd</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="founder-metric-val">
              Giá trị mới
            </label>
            <input
              id="founder-metric-val"
              type="number"
              value={metricValue}
              onChange={(e) => setMetricValue(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="founder-rationale">
              Lý do thay đổi (kèm bằng chứng)
            </label>
            <input
              id="founder-rationale"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Ví dụ: Giảm giờ hỗ trợ nhờ chuẩn hóa báo giá"
            />
          </div>
          <button type="submit" className="btn btn--small" disabled={submitting}>
            {submitting ? 'Đang gửi…' : 'Tạo đề xuất (ChangeProposal)'}
          </button>
        </form>

        <h3 className="section-subhead">Danh sách đề xuất ({proposals.length})</h3>
        {proposals.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Thay đổi</th>
                <th scope="col">Lý do</th>
                <th scope="col">Trạng thái</th>
                <th scope="col">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((prop) => (
                <tr key={prop.id}>
                  <td><code className="code-chip">{prop.changes_json}</code></td>
                  <td>{prop.rationale}</td>
                  <td>
                    <span className={founderBadgeClass(prop.status)}>{prop.status}</span>
                  </td>
                  <td>
                    {prop.status === 'draft' && (
                      <button
                        type="button"
                        className="btn btn--secondary btn--small"
                        onClick={() => void handleApplyProposal(prop.id)}
                      >
                        Áp dụng
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 className="section-subhead">
          Lịch sử phiên bản cấu hình ({versions.length})
        </h3>
        {versions.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Phiên bản</th>
                <th scope="col">Thời điểm</th>
                <th scope="col">Khôi phục</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((ver) => (
                <tr key={ver.id}>
                  <td>
                    <strong>v{ver.version_number}</strong>
                    {activeVersion?.id === ver.id && <span className="badge badge--success badge--spaced-left">Đang chạy</span>}
                  </td>
                  <td>{formatTimestamp(ver.created_at)}</td>
                  <td>
                    {activeVersion?.id !== ver.id && (
                      <button
                        type="button"
                        className="btn btn--secondary btn--small"
                        onClick={() => void handleRollback(ver.id)}
                      >
                        Rollback về v{ver.version_number}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 4. OPC Commercial Ledger */}
      <section className="panel span-full" id="founder-opc" aria-labelledby="opc-ledger-heading">
        <h2 className="panel__title" id="opc-ledger-heading">
          Sổ Cái Thương Mại OPC (Tách Biệt Với Phiếu Thu Đơn Hàng Cây Cảnh)
        </h2>
        {opcLedger !== null && (
          <div className="grid grid--two">
            <div>
              <h3 className="section-subhead">Nghĩa vụ thanh toán OPC ({opcLedger.obligations.length})</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Loại nghĩa vụ</th>
                    <th scope="col" className="num">Số tiền</th>
                    <th scope="col">Hạn</th>
                    <th scope="col">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {opcLedger.obligations.map((ob) => (
                    <tr key={ob.id}>
                      <td>{ob.obligation_kind}</td>
                      <td className="num money">{formatVndWithUnit(ob.amount_vnd)}</td>
                      <td>{ob.due_date}</td>
                      <td>
                        <span className={founderBadgeClass(ob.status)}>{ob.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="section-subhead">Phiếu thu OPC &amp; Khấu trừ Pilot Credit ({opcLedger.receipts.length})</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Mã tham chiếu</th>
                    <th scope="col">Loại phí</th>
                    <th scope="col" className="num">Thực thu</th>
                  </tr>
                </thead>
                <tbody>
                  {opcLedger.receipts.map((rc) => (
                    <tr key={rc.id}>
                      <td>{rc.reference}</td>
                      <td>{rc.fee_type}</td>
                      <td className="num money">{formatVndWithUnit(rc.amount_vnd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {opcLedger.pilotCredits.length > 0 && (
                <p className="field__hint section-subhead">
                  Pilot Credit đã cấp: {opcLedger.pilotCredits.map((c) => `${formatVndWithUnit(c.credit_amount_vnd)} (${c.applied_to_obligation_id ? 'Đã khấu trừ vào phí cài đặt' : 'Chưa dùng'})`).join(', ')}
                </p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
