/**
 * Founder area: discovery, configuration, economics, and the OPC ledger.
 *
 * What a founder does here, in the order the screen presents it:
 *
 * 1. **Discovery** — interviews and the observations they yielded. A batch of
 *    interviews arrives as JSON: preview says what apply would do to each one
 *    (create, new revision, or nothing) without writing, and apply writes the
 *    whole batch or none of it.
 * 2. **Configuration** — every proposal cites observations and a reason; apply
 *    publishes an immutable version against the version it was based on, and
 *    a losing race is refused rather than silently overwriting. Rollback
 *    publishes a new version that copies an older one and says which.
 * 3. **Economics** — simulations of the active parameters. The screen names
 *    where the parameters came from and repeats the formulas, because these
 *    numbers are not revenue and no reader should mistake them for it.
 * 4. **OPC ledger** — what each nursery owes the OPC (obligations), what has
 *    been confirmed received (receipts), and single-use pilot credits. The
 *    three headline figures are kept apart: active MRR is a contract figure,
 *    cash collected is confirmed receipts, receivables are what is still owed.
 *
 * Money inputs are whole đồng with `step={1}`: a coarser step (e.g. 1000) is
 * validated against `min`, so 5.000.000 with `min={1}` is not a step of that
 * sequence and the browser silently refuses to submit the form at all.
 *
 * Every write carries one `Idempotency-Key` per intent, reused across retries
 * of that intent, and a synchronous in-flight guard so a double click cannot
 * send two. Success is reported only after the server answered, and every
 * action re-reads the lists rather than trusting what it sent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  OPC_FEE_TYPES,
  OPC_OBLIGATION_KINDS,
  applyFounderImportApi,
  applyFounderProposalApi,
  applyPilotCreditApi,
  confirmOpcReceiptApi,
  createFounderProposalApi,
  createOpcAgreementApi,
  fetchFounderConfig,
  fetchFounderEconomics,
  fetchFounderInterviews,
  fetchFounderOpcLedger,
  newIdempotencyKey,
  previewFounderImportApi,
  recordOpcObligationApi,
  rollbackFounderConfigApi,
  type ChangeProposalView,
  type ConfigVersionView,
  type FounderEconomicsResponse,
  type FounderInterviewView,
  type FounderObservationView,
  type ImportPreviewView,
  type OpcLedgerResponse,
  type SessionWorkspace,
} from '../api.ts';
import { formatTimestamp, formatVndWithUnit } from '../format.ts';
import { EmptyState, ErrorState, LoadingState, SuccessState } from './states.tsx';

export interface FounderScreenProps {
  workspaceId: string;
  /** The caller's own live memberships, from the session — targets only. */
  workspaces: readonly SessionWorkspace[];
}

function founderBadgeClass(status: string): string {
  switch (status) {
    case 'applied':
    case 'paid':
    case 'real':
    case 'measured':
    case 'settled':
    case 'confirmed':
      return 'badge badge--success';
    case 'reported':
    case 'assumption':
    case 'pending':
      return 'badge badge--info';
    case 'draft':
    case 'synthetic':
    case 'partially_settled':
      return 'badge badge--warning';
    case 'rejected':
    case 'overdue':
    case 'cancelled':
      return 'badge badge--danger';
    default:
      return 'badge';
  }
}

function errorText(thrown: unknown, fallback: string): string {
  if (thrown instanceof ApiError) {
    // The code says what happened; the sentence says it in Vietnamese.
    return thrown.code === null ? thrown.message : `${thrown.message}`;
  }
  return thrown instanceof Error ? thrown.message : fallback;
}

const OBLIGATION_LABELS: Record<string, string> = {
  pilot_fee: 'Phí thí điểm',
  setup_fee: 'Phí cài đặt',
  monthly_subscription: 'Thuê bao tháng',
  service_fee: 'Phí dịch vụ',
};

const FEE_LABELS: Record<string, string> = {
  pilot_fee: 'Phí thí điểm',
  setup_fee: 'Phí cài đặt',
  monthly_subscription: 'Thuê bao tháng',
  upgrade_fee: 'Phí nâng cấp',
  other: 'Khác',
};

export function FounderScreen({ workspaceId, workspaces }: FounderScreenProps) {
  const [interviews, setInterviews] = useState<FounderInterviewView[]>([]);
  const [observations, setObservations] = useState<FounderObservationView[]>([]);
  const [activeVersion, setActiveVersion] = useState<ConfigVersionView | null>(null);
  const [versions, setVersions] = useState<ConfigVersionView[]>([]);
  const [proposals, setProposals] = useState<ChangeProposalView[]>([]);
  const [economics, setEconomics] = useState<FounderEconomicsResponse | null>(null);
  const [ledger, setLedger] = useState<OpcLedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The one write in flight, by intent. A second click while it is pending is
  // ignored rather than sent, so a double click cannot write twice. The ref is
  // the synchronous copy, because two clicks in one event-loop turn both read
  // the state before React re-renders.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const intentKeys = useRef(new Map<string, string>());

  // Proposal form
  const [metricKey, setMetricKey] = useState('support_hours_per_customer_month');
  const [metricValue, setMetricValue] = useState('3');
  const [rationale, setRationale] = useState('');
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  // Import panel
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreviewView | null>(null);
  const [importTarget, setImportTarget] = useState(workspaces[0]?.workspaceId ?? workspaceId);
  // OPC forms
  const [opcTarget, setOpcTarget] = useState(workspaces[0]?.workspaceId ?? workspaceId);
  const [agreementMonthly, setAgreementMonthly] = useState('3000000');
  const [agreementSetup, setAgreementSetup] = useState('10000000');
  const [agreementEffective, setAgreementEffective] = useState('2026-11-01');
  const [obligationAgreement, setObligationAgreement] = useState('');
  const [obligationKind, setObligationKind] = useState<string>('monthly_subscription');
  const [obligationAmount, setObligationAmount] = useState('3000000');
  const [obligationDue, setObligationDue] = useState('2026-12-05');
  const [receiptAgreement, setReceiptAgreement] = useState('');
  const [receiptObligation, setReceiptObligation] = useState('');
  const [receiptAmount, setReceiptAmount] = useState('');
  const [receiptFeeType, setReceiptFeeType] = useState<string>('monthly_subscription');
  const [receiptReference, setReceiptReference] = useState('');

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
      setLedger(ledgerData);
      setAgreementMonthly((current) => current);
    } catch (thrown) {
      setError(errorText(thrown, 'Không tải được dữ liệu Sáng lập.'));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runAction = useCallback(
    async (intent: string, perform: (idempotencyKey: string) => Promise<string>) => {
      if (busyRef.current !== null) return;
      busyRef.current = intent;
      setBusyAction(intent);
      setActionError(null);
      setNotice(null);
      const key = intentKeys.current.get(intent) ?? newIdempotencyKey();
      intentKeys.current.set(intent, key);
      try {
        const message = await perform(key);
        intentKeys.current.delete(intent);
        setNotice(message);
        await reload();
      } catch (thrown) {
        setActionError(errorText(thrown, 'Không thực hiện được thao tác.'));
        if (thrown instanceof ApiError && thrown.status !== 0 && thrown.status < 500) {
          // The server answered (refused or stale): the intent is settled and
          // the lists should show the state the refusal was about.
          intentKeys.current.delete(intent);
          await reload();
        }
      } finally {
        busyRef.current = null;
        setBusyAction(null);
      }
    },
    [reload],
  );

  const busy = busyAction !== null;
  const targets = workspaces.length > 0 ? workspaces : [{ workspaceId, name: workspaceId, role: 'founder_admin' as const }];
  const obligations = ledger?.obligations ?? [];
  const openObligations = obligations.filter((o) => o.status === 'pending' || o.status === 'partially_settled');
  const currentAgreement = ledger?.agreements.find((a) => a.workspace_id === opcTarget) ?? ledger?.agreements[0];

  const observationLabel = useMemo(() => {
    const byId = new Map(interviews.map((iv) => [iv.id, iv.external_id]));
    const map = new Map<string, string>();
    for (const obs of observations) {
      map.set(obs.id, `${byId.get(obs.interview_id) ?? obs.interview_id} · ${obs.metric_key}`);
    }
    return map;
  }, [interviews, observations]);

  const toggleEvidence = (id: string) => {
    setEvidenceIds((current) =>
      current.includes(id) ? current.filter((e) => e !== id) : [...current, id],
    );
  };

  const parseImport = (): { items: unknown[] } | null => {
    try {
      const parsed = JSON.parse(importText) as unknown;
      const items =
        Array.isArray(parsed) ? parsed : (parsed as { items?: unknown[] }).items;
      if (!Array.isArray(items) || items.length === 0) {
        setActionError('Nội dung nhập phải là một mảng phỏng vấn, hoặc { "items": [...] }.');
        return null;
      }
      return { items };
    } catch {
      setActionError('Nội dung nhập không phải JSON hợp lệ.');
      return null;
    }
  };

  const handlePreview = () =>
    runAction('import-preview', async () => {
      const payload = parseImport();
      if (payload === null) throw new Error('Nội dung nhập không phải JSON hợp lệ.');
      const res = await previewFounderImportApi(importTarget, payload);
      setImportPreview(res.preview);
      return `Xem trước: ${res.preview.create_count} tạo mới, ${res.preview.revision_count} bản sửa, ${res.preview.unchanged_count} không đổi — chưa ghi gì.`;
    });

  const handleApplyImport = () =>
    runAction('import-apply', async (key) => {
      const payload = parseImport();
      if (payload === null) throw new Error('Nội dung nhập không phải JSON hợp lệ.');
      const res = await applyFounderImportApi(importTarget, payload, key);
      setImportPreview(null);
      setImportText('');
      return `Đã nhập ${res.applied_count} phỏng vấn (${res.create_count} tạo mới, ${res.revision_count} bản sửa), ${res.observations_count} quan sát — một giao dịch.`;
    });

  const handleCreateProposal = () =>
    runAction('proposal-create', async (key) => {
      const numVal = Number(metricValue);
      if (!Number.isFinite(numVal) || numVal < 0) {
        throw new Error('Giá trị tham số phải là số hợp lệ không âm.');
      }
      if (evidenceIds.length === 0) {
        throw new Error('Chọn ít nhất một quan sát làm bằng chứng.');
      }
      if (rationale.trim() === '') {
        throw new Error('Nêu lý do thay đổi.');
      }
      const res = await createFounderProposalApi(
        workspaceId,
        {
          scope: 'business_model',
          base_version_id: activeVersion?.id ?? null,
          changes: { [metricKey]: numVal },
          evidence_ids: evidenceIds,
          rationale: rationale.trim(),
        },
        key,
      );
      setRationale('');
      return `Đã tạo đề xuất ${res.proposal.id} trên cơ sở v${activeVersion?.version_number ?? 1}.`;
    });

  const handleApplyProposal = (proposalId: string) =>
    runAction(`proposal-apply:${proposalId}`, async (key) => {
      const res = await applyFounderProposalApi(workspaceId, proposalId, key);
      return `Đã áp dụng đề xuất → phiên bản v${res.version.version_number} (bất biến).`;
    });

  const handleRollback = (versionId: string, versionNumber: number) =>
    runAction(`rollback:${versionId}`, async (key) => {
      const res = await rollbackFounderConfigApi(workspaceId, versionId, key);
      return `Đã khôi phục cấu hình từ v${versionNumber} → phiên bản mới v${res.version.version_number}.`;
    });

  const handleCreateAgreement = () =>
    runAction('opc-agreement-create', async (key) => {
      const monthly = Number(agreementMonthly);
      const setup = Number(agreementSetup);
      if (!Number.isInteger(monthly) || monthly < 0 || !Number.isInteger(setup) || setup < 0) {
        throw new Error('Phí thuê bao và phí cài đặt phải là số nguyên không âm (VND).');
      }
      const res = await createOpcAgreementApi(
        workspaceId,
        { target_workspace_id: opcTarget, monthly_fee_vnd: monthly, setup_fee_vnd: setup, effective_date: agreementEffective },
        key,
      );
      setObligationAgreement(res.agreement.id);
      setReceiptAgreement(res.agreement.id);
      return `Đã tạo hợp đồng OPC cho ${opcTarget}.`;
    });

  const handleRecordObligation = () =>
    runAction('opc-obligation-record', async (key) => {
      const amount = Number(obligationAmount);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error('Số tiền nghĩa vụ phải là số nguyên lớn hơn 0.');
      }
      const agreementId = obligationAgreement !== '' ? obligationAgreement : (currentAgreement?.id ?? '');
      if (agreementId === '') throw new Error('Chọn hợp đồng OPC trước.');
      const res = await recordOpcObligationApi(
        workspaceId,
        {
          agreement_id: agreementId,
          target_workspace_id: opcTarget,
          obligation_kind: obligationKind as (typeof OPC_OBLIGATION_KINDS)[number],
          amount_vnd: amount,
          due_date: obligationDue,
        },
        key,
      );
      return `Đã ghi nghĩa vụ ${formatVndWithUnit(res.obligation.amount_vnd)} hạn ${res.obligation.due_date}.`;
    });

  const handleConfirmReceipt = () =>
    runAction('opc-receipt-confirm', async (key) => {
      const amount = Number(receiptAmount);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error('Số tiền thu phải là số nguyên lớn hơn 0.');
      }
      if (receiptReference.trim() === '') throw new Error('Ghi mã tham chiếu chuyển khoản.');
      const agreementId = receiptAgreement !== '' ? receiptAgreement : (currentAgreement?.id ?? '');
      if (agreementId === '') throw new Error('Chọn hợp đồng OPC trước.');
      const res = await confirmOpcReceiptApi(
        workspaceId,
        {
          agreement_id: agreementId,
          target_workspace_id: opcTarget,
          obligation_id: receiptObligation === '' ? null : receiptObligation,
          amount_vnd: amount,
          fee_type: receiptFeeType as (typeof OPC_FEE_TYPES)[number],
          reference: receiptReference.trim(),
        },
        key,
      );
      setReceiptAmount('');
      setReceiptReference('');
      return res.pilotCredit === undefined
        ? `Đã ghi nhận thu ${formatVndWithUnit(res.receipt.amount_vnd)} (${res.receipt.reference}).`
        : `Đã ghi nhận thu ${formatVndWithUnit(res.receipt.amount_vnd)} và cấp pilot credit ${formatVndWithUnit(res.pilotCredit.credit_amount_vnd)} (dùng 1 lần).`;
    });

  const handleApplyCredit = (creditId: string, obligationId: string) =>
    runAction(`opc-credit-apply:${creditId}`, async (key) => {
      const res = await applyPilotCreditApi(
        workspaceId,
        { credit_id: creditId, obligation_id: obligationId, target_workspace_id: opcTarget },
        key,
      );
      return `Đã khấu trừ ${formatVndWithUnit(res.credit.credit_amount_vnd)} vào nghĩa vụ → ${res.obligation.status}.`;
    });

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
      <nav aria-label="Các phần của phân hệ sáng lập" className="stepper-bar">
        <span className="stepper-bar__title">Phân hệ Sáng lập</span>
        <a className="stepper-bar__item" href="#founder-economics">
          <span className="stepper-bar__step-num">1</span>
          Kinh tế OPC
        </a>
        <a className="stepper-bar__item" href="#founder-interviews">
          <span className="stepper-bar__step-num">2</span>
          Phỏng vấn &amp; nhập dữ liệu
        </a>
        <a className="stepper-bar__item" href="#founder-config">
          <span className="stepper-bar__step-num">3</span>
          Cấu hình &amp; đề xuất
        </a>
        <a className="stepper-bar__item" href="#founder-opc">
          <span className="stepper-bar__step-num">4</span>
          Sổ cái OPC
        </a>
      </nav>

      {notice !== null && (
        <div className="span-full" role="status">
          <SuccessState title={notice} />
        </div>
      )}
      {actionError !== null && (
        <div className="span-full" role="alert">
          <ErrorState title="Thao tác bị từ chối">
            <p>{actionError}</p>
          </ErrorState>
        </div>
      )}

      {/* 1. Economics */}
      <section className="panel span-full" id="founder-economics" aria-labelledby="econ-heading">
        <div className="panel__header">
          <h2 className="panel__title" id="econ-heading">
            Kinh tế đơn vị OPC &amp; kịch bản công suất
          </h2>
          <span className="badge badge--warning" data-testid="scenario-simulation-badge">
            MÔ PHỎNG — không phải số thực thu
          </span>
        </div>

        {economics !== null && (
          <>
            <p className="field__hint">
              {economics.parameters_source.kind === 'config_version'
                ? `Tham số từ phiên bản cấu hình v${economics.parameters_source.version_number} (${economics.parameters_source.version_id}).`
                : economics.parameters_source.note}
            </p>
            <ul className="field__hint">
              {economics.assumptions.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="table-wrap">
              <table className="table table--spaced">
                <thead>
                  <tr>
                    <th scope="col">Kịch bản (N khách / S cài đặt mới)</th>
                    <th scope="col" className="num">Doanh thu mô phỏng</th>
                    <th scope="col" className="num">Chi phí tiền mặt</th>
                    <th scope="col" className="num">Chênh lệch tiền mặt</th>
                    <th scope="col" className="num">Giờ công sáng lập</th>
                    <th scope="col" className="num">Lợi nhuận kinh tế</th>
                    <th scope="col" className="num">Công suất dùng</th>
                  </tr>
                </thead>
                <tbody>
                  {economics.scenarios.map((sc) => (
                    <tr key={`${sc.customers}-${sc.new_setups}`}>
                      <td>
                        <strong>
                          N={sc.customers}, S={sc.new_setups}
                        </strong>
                      </td>
                      <td className="num money">{formatVndWithUnit(sc.revenue_vnd)}</td>
                      <td className="num money">{formatVndWithUnit(sc.cash_cost_vnd)}</td>
                      <td className="num money">{formatVndWithUnit(sc.cash_surplus_vnd)}</td>
                      <td className="num">
                        {sc.hours}h
                        <div className="field__hint">
                          quy đổi {formatVndWithUnit(sc.founder_value_vnd)}
                        </div>
                      </td>
                      <td className="num money">{formatVndWithUnit(sc.economic_remainder_vnd)}</td>
                      <td className="num">
                        {sc.capacity_utilization.kind === 'value'
                          ? `${Math.round(sc.capacity_utilization.value * 100)}%`
                          : 'Không xác định'}
                        {sc.capacity_utilization.kind === 'value' && sc.capacity_utilization.value > 1 && (
                          <div className="field__hint text-danger">Vượt trần giờ/tháng</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* 2. Interviews, observations, import */}
      <section className="panel" id="founder-interviews" aria-labelledby="interviews-heading">
        <div className="panel__header">
          <h2 className="panel__title" id="interviews-heading">
            Phỏng vấn &amp; quan sát thực địa ({interviews.length})
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
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Mã</th>
                  <th scope="col">Đơn vị / vai trò</th>
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
                      <div className="field__hint">
                        {iv.respondent_role} ({iv.interviewed_at})
                      </div>
                    </td>
                    <td>
                      <span className={founderBadgeClass(iv.data_origin)}>
                        {iv.data_origin === 'synthetic' ? 'MẪU (synthetic)' : 'Thực tế'}
                      </span>
                    </td>
                    <td>v{iv.revision}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="section-subhead">Quan sát định lượng ({observations.length})</h3>
        {observations.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Chỉ số</th>
                  <th scope="col" className="num">Giá trị</th>
                  <th scope="col">Bằng chứng</th>
                </tr>
              </thead>
              <tbody>
                {observations.map((obs) => (
                  <tr key={obs.id}>
                    <td>
                      {obs.metric_key}
                      <div className="field__hint">{obs.source_ref ?? '—'}</div>
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
          </div>
        )}

        <h3 className="section-subhead">Nhập lô phỏng vấn (JSON)</h3>
        <p className="field__hint">
          Xem trước chỉ đọc và cho biết mỗi mã sẽ được tạo mới, thành bản sửa hay giữ nguyên. Áp dụng ghi cả
          lô trong một giao dịch: hoặc tất cả, hoặc không dòng nào.
        </p>
        <form
          className="form-block"
          onSubmit={(e) => {
            e.preventDefault();
            void handlePreview();
          }}
        >
          <div className="field">
            <label className="field__label" htmlFor="founder-import-target">
              Không gian làm việc đích
            </label>
            <select
              id="founder-import-target"
              value={importTarget}
              onChange={(e) => setImportTarget(e.target.value)}
            >
              {targets.map((ws) => (
                <option key={ws.workspaceId} value={ws.workspaceId}>
                  {ws.name} ({ws.workspaceId})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="founder-import-json">
              Nội dung JSON
            </label>
            <textarea
              id="founder-import-json"
              rows={5}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={'{ "items": [ { "external_id": "INT-2026-010", … } ] }'}
            />
          </div>
          <div className="btn-row">
            <button
              type="submit"
              className="btn btn--secondary btn--small"
              disabled={busy || importText.trim() === ''}
              aria-busy={busyAction === 'import-preview'}
            >
              {busyAction === 'import-preview' ? 'Đang xem trước…' : 'Xem trước (không ghi)'}
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy || importPreview === null}
              aria-busy={busyAction === 'import-apply'}
              onClick={() => void handleApplyImport()}
            >
              {busyAction === 'import-apply' ? 'Đang áp dụng…' : 'Áp dụng cả lô'}
            </button>
          </div>
        </form>
        {importPreview !== null && (
          <div className="table-wrap">
            <table className="table" aria-label="Kế hoạch nhập phỏng vấn">
              <thead>
                <tr>
                  <th scope="col">Mã phỏng vấn</th>
                  <th scope="col">Hành động</th>
                  <th scope="col" className="num">Quan sát</th>
                </tr>
              </thead>
              <tbody>
                {importPreview.items.map((item) => (
                  <tr key={item.external_id}>
                    <td>{item.external_id}</td>
                    <td>
                      {item.action === 'create'
                        ? `Tạo mới (v${item.revision})`
                        : item.action === 'revise'
                          ? `Bản sửa v${item.revision}`
                          : `Giữ nguyên v${item.revision}`}
                    </td>
                    <td className="num">{item.observations_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. Proposals and versions */}
      <section className="panel" id="founder-config" aria-labelledby="config-heading">
        <h2 className="panel__title" id="config-heading">
          Đề xuất thay đổi &amp; phiên bản cấu hình (đang chạy: v{activeVersion?.version_number ?? '—'})
        </h2>

        <form
          className="form-block"
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreateProposal();
          }}
        >
          <div className="field">
            <label className="field__label" htmlFor="founder-metric-key">
              Tham số muốn điều chỉnh
            </label>
            <select id="founder-metric-key" value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
              <option value="support_hours_per_customer_month">support_hours_per_customer_month</option>
              <option value="setup_hours_per_customer">setup_hours_per_customer</option>
              <option value="pilot_fee_vnd">pilot_fee_vnd</option>
              <option value="setup_fee_vnd">setup_fee_vnd</option>
              <option value="monthly_fee_vnd">monthly_fee_vnd</option>
              <option value="direct_cost_per_customer_month_vnd">direct_cost_per_customer_month_vnd</option>
              <option value="capacity_hours_per_month">capacity_hours_per_month</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="founder-metric-val">
              Giá trị mới
            </label>
            <input
              id="founder-metric-val"
              type="number"
              min={0}
              step={1}
              value={metricValue}
              onChange={(e) => setMetricValue(e.target.value)}
            />
          </div>
          <fieldset className="field">
            <legend className="field__label">Bằng chứng (quan sát) — bắt buộc chọn ít nhất một</legend>
            {observations.length === 0 ? (
              <p className="field__hint">Chưa có quan sát nào; hãy ghi phỏng vấn trước khi đề xuất tham số.</p>
            ) : (
              <ul className="check-list">
                {observations.slice(0, 30).map((obs) => (
                  <li key={obs.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={evidenceIds.includes(obs.id)}
                        onChange={() => toggleEvidence(obs.id)}
                      />{' '}
                      {observationLabel.get(obs.id) ?? obs.metric_key}
                      {obs.value_num !== null ? ` = ${obs.value_num}` : ''}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <div className="field">
            <label className="field__label" htmlFor="founder-rationale">
              Lý do thay đổi
            </label>
            <input
              id="founder-rationale"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Ví dụ: giảm giờ hỗ trợ nhờ mẫu báo giá chuẩn hóa"
            />
          </div>
          <button
            type="submit"
            className="btn btn--small"
            disabled={busy}
            aria-busy={busyAction === 'proposal-create'}
          >
            {busyAction === 'proposal-create' ? 'Đang gửi…' : 'Tạo đề xuất'}
          </button>
        </form>

        <h3 className="section-subhead">Đề xuất ({proposals.length})</h3>
        {proposals.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Thay đổi</th>
                  <th scope="col">Cơ sở</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((prop) => (
                  <tr key={prop.id}>
                    <td>
                      <code className="code-chip">{prop.changes_json}</code>
                      <div className="field__hint">{prop.rationale}</div>
                    </td>
                    <td>
                      {prop.base_version_id === null
                        ? '—'
                        : versions.find((v) => v.id === prop.base_version_id)?.version_number !== undefined
                          ? `v${versions.find((v) => v.id === prop.base_version_id)!.version_number}`
                          : prop.base_version_id}
                    </td>
                    <td>
                      <span className={founderBadgeClass(prop.status)}>{prop.status}</span>
                    </td>
                    <td>
                      {(prop.status === 'draft' || prop.status === 'approved') && (
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
                          disabled={busy}
                          aria-busy={busyAction === `proposal-apply:${prop.id}`}
                          onClick={() => void handleApplyProposal(prop.id)}
                        >
                          {busyAction === `proposal-apply:${prop.id}` ? 'Đang áp dụng…' : 'Áp dụng'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="section-subhead">Lịch sử phiên bản ({versions.length})</h3>
        {versions.length > 0 && (
          <div className="table-wrap">
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
                      {activeVersion?.id === ver.id && (
                        <span className="badge badge--success badge--spaced-left">Đang chạy</span>
                      )}
                      {ver.restored_from_version_id !== null && (
                        <div className="field__hint">
                          Khôi phục từ{' '}
                          {versions.find((v) => v.id === ver.restored_from_version_id)?.version_number !== undefined
                            ? `v${versions.find((v) => v.id === ver.restored_from_version_id)!.version_number}`
                            : ver.restored_from_version_id}
                        </div>
                      )}
                    </td>
                    <td>{formatTimestamp(ver.created_at)}</td>
                    <td>
                      {activeVersion?.id !== ver.id && (
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
                          disabled={busy}
                          aria-busy={busyAction === `rollback:${ver.id}`}
                          onClick={() => void handleRollback(ver.id, ver.version_number)}
                        >
                          {busyAction === `rollback:${ver.id}` ? 'Đang khôi phục…' : `Khôi phục v${ver.version_number}`}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. OPC ledger */}
      <section className="panel span-full" id="founder-opc" aria-labelledby="opc-ledger-heading">
        <h2 className="panel__title" id="opc-ledger-heading">
          Sổ cái thương mại OPC (tách biệt phiếu thu đơn hàng cây cảnh)
        </h2>
        <p className="field__hint">
          Ba con số dưới đây là ba thứ khác nhau: MRR là số hợp đồng đang hiệu lực, tiền đã thu là phiếu thu đã
          xác nhận, còn phải thu là nghĩa vụ trừ đi phiếu thu và tín dụng đã khấu trừ. Một mã chuyển khoản chỉ là
          ghi nhận của người xác nhận, không phải bằng chứng ngân hàng.
        </p>

        {ledger !== null && (
          <div className="grid grid--three">
            <div className="metric">
              <span className="metric__label">MRR đang hiệu lực</span>
              <span className="metric__value money">{formatVndWithUnit(ledger.metrics.active_mrr_vnd)}</span>
            </div>
            <div className="metric">
              <span className="metric__label">Tiền đã thu (phiếu thu xác nhận)</span>
              <span className="metric__value money">{formatVndWithUnit(ledger.metrics.cash_collected_vnd)}</span>
            </div>
            <div className="metric">
              <span className="metric__label">Còn phải thu</span>
              <span className="metric__value money">
                {formatVndWithUnit(ledger.metrics.outstanding_receivables_vnd)}
              </span>
            </div>
          </div>
        )}

        <div className="field">
          <label className="field__label" htmlFor="founder-opc-target">
            Không gian làm việc của khách OPC
          </label>
          <select id="founder-opc-target" value={opcTarget} onChange={(e) => setOpcTarget(e.target.value)}>
            {targets.map((ws) => (
              <option key={ws.workspaceId} value={ws.workspaceId}>
                {ws.name} ({ws.workspaceId})
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid--two">
          <div>
            <h3 className="section-subhead">Hợp đồng OPC</h3>
            {ledger !== null && ledger.agreements.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Không gian</th>
                      <th scope="col" className="num">Thuê bao / tháng</th>
                      <th scope="col" className="num">Phí cài đặt</th>
                      <th scope="col">Hiệu lực</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.agreements.map((ag) => (
                      <tr key={ag.id}>
                        <td>
                          {ag.workspace_id}
                          <div className="field__hint">
                            <span className={founderBadgeClass(ag.status)}>{ag.status}</span>
                          </div>
                        </td>
                        <td className="num money">{formatVndWithUnit(ag.monthly_fee_vnd)}</td>
                        <td className="num money">{formatVndWithUnit(ag.setup_fee_vnd)}</td>
                        <td>{ag.effective_date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <form
              className="form-block"
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreateAgreement();
              }}
            >
              <div className="field">
                <label className="field__label" htmlFor="opc-agreement-monthly">
                  Phí thuê bao tháng (VND)
                </label>
                <input
                  id="opc-agreement-monthly"
                  type="number"
                  min={0}
                  step={1}
                  value={agreementMonthly}
                  onChange={(e) => setAgreementMonthly(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="opc-agreement-setup">
                  Phí cài đặt (VND)
                </label>
                <input
                  id="opc-agreement-setup"
                  type="number"
                  min={0}
                  step={1}
                  value={agreementSetup}
                  onChange={(e) => setAgreementSetup(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="opc-agreement-effective">
                  Ngày hiệu lực
                </label>
                <input
                  id="opc-agreement-effective"
                  value={agreementEffective}
                  onChange={(e) => setAgreementEffective(e.target.value)}
                />
              </div>
              <button
                type="submit"
                className="btn btn--small"
                disabled={busy}
                aria-busy={busyAction === 'opc-agreement-create'}
              >
                {busyAction === 'opc-agreement-create' ? 'Đang tạo…' : 'Tạo hợp đồng OPC'}
              </button>
            </form>
          </div>

          <div>
            <h3 className="section-subhead">Ghi nghĩa vụ</h3>
            <form
              className="form-block"
              onSubmit={(e) => {
                e.preventDefault();
                void handleRecordObligation();
              }}
            >
              <div className="field">
                <label className="field__label" htmlFor="opc-obligation-agreement">
                  Hợp đồng
                </label>
                <select
                  id="opc-obligation-agreement"
                  value={obligationAgreement}
                  onChange={(e) => setObligationAgreement(e.target.value)}
                >
                  {ledger?.agreements.map((ag) => (
                    <option key={ag.id} value={ag.id}>
                      {ag.id} — {ag.workspace_id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="opc-obligation-kind">
                  Loại nghĩa vụ
                </label>
                <select
                  id="opc-obligation-kind"
                  value={obligationKind}
                  onChange={(e) => setObligationKind(e.target.value)}
                >
                  {OPC_OBLIGATION_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {OBLIGATION_LABELS[kind] ?? kind}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="opc-obligation-amount">
                  Số tiền (VND)
                </label>
                <input
                  id="opc-obligation-amount"
                  type="number"
                  min={1}
                  step={1}
                  value={obligationAmount}
                  onChange={(e) => setObligationAmount(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="opc-obligation-due">
                  Hạn thanh toán
                </label>
                <input
                  id="opc-obligation-due"
                  value={obligationDue}
                  onChange={(e) => setObligationDue(e.target.value)}
                />
              </div>
              <button
                type="submit"
                className="btn btn--small"
                disabled={busy || (ledger?.agreements.length ?? 0) === 0}
                aria-busy={busyAction === 'opc-obligation-record'}
              >
                {busyAction === 'opc-obligation-record' ? 'Đang ghi…' : 'Ghi nghĩa vụ'}
              </button>
            </form>
          </div>
        </div>

        <h3 className="section-subhead">Nghĩa vụ ({obligations.length})</h3>
        {obligations.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Loại</th>
                  <th scope="col" className="num">Số tiền</th>
                  <th scope="col">Hạn</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {obligations.map((ob) => {
                  const credit = ledger?.pilotCredits.find((c) => c.applied_to_obligation_id === null);
                  return (
                    <tr key={ob.id}>
                      <td>{OBLIGATION_LABELS[ob.obligation_kind] ?? ob.obligation_kind}</td>
                      <td className="num money">{formatVndWithUnit(ob.amount_vnd)}</td>
                      <td>{ob.due_date}</td>
                      <td>
                        <span className={founderBadgeClass(ob.status)}>{ob.status}</span>
                      </td>
                      <td>
                        {credit !== undefined && (ob.status === 'pending' || ob.status === 'partially_settled') && (
                          <button
                            type="button"
                            className="btn btn--secondary btn--small"
                            disabled={busy}
                            aria-busy={busyAction === `opc-credit-apply:${credit.id}`}
                            onClick={() => void handleApplyCredit(credit.id, ob.id)}
                          >
                            {busyAction === `opc-credit-apply:${credit.id}`
                              ? 'Đang khấu trừ…'
                              : `Khấu trừ tín dụng ${formatVndWithUnit(credit.credit_amount_vnd)}`}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid grid--two">
          <div>
            <h3 className="section-subhead">Xác nhận phiếu thu OPC</h3>
            <form
              className="form-block"
              onSubmit={(e) => {
                e.preventDefault();
                void handleConfirmReceipt();
              }}
            >
              <div className="field">
                <label className="field__label" htmlFor="opc-receipt-agreement">
                  Hợp đồng
                </label>
                <select
                  id="opc-receipt-agreement"
                  value={receiptAgreement}
                  onChange={(e) => setReceiptAgreement(e.target.value)}
                >
                  {ledger?.agreements.map((ag) => (
                    <option key={ag.id} value={ag.id}>
                      {ag.id} — {ag.workspace_id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="opc-receipt-obligation">
                  Nghĩa vụ (tuỳ chọn)
                </label>
                <select
                  id="opc-receipt-obligation"
                  value={receiptObligation}
                  onChange={(e) => setReceiptObligation(e.target.value)}
                >
                  <option value="">Không gắn nghĩa vụ</option>
                  {openObligations.map((ob) => (
                    <option key={ob.id} value={ob.id}>
                      {OBLIGATION_LABELS[ob.obligation_kind] ?? ob.obligation_kind} —{' '}
                      {formatVndWithUnit(ob.amount_vnd)} — hạn {ob.due_date}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="opc-receipt-amount">
                  Số tiền đã nhận (VND)
                </label>
                <input
                  id="opc-receipt-amount"
                  type="number"
                  min={1}
                  step={1}
                  value={receiptAmount}
                  onChange={(e) => setReceiptAmount(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="opc-receipt-fee-type">
                  Loại phí
                </label>
                <select
                  id="opc-receipt-fee-type"
                  value={receiptFeeType}
                  onChange={(e) => setReceiptFeeType(e.target.value)}
                >
                  {OPC_FEE_TYPES.map((fee) => (
                    <option key={fee} value={fee}>
                      {FEE_LABELS[fee] ?? fee}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="opc-receipt-reference">
                  Mã tham chiếu chuyển khoản
                </label>
                <input
                  id="opc-receipt-reference"
                  value={receiptReference}
                  onChange={(e) => setReceiptReference(e.target.value)}
                  placeholder="Ví dụ: OPC-CK-2026-11"
                />
              </div>
              <button
                type="submit"
                className="btn btn--small"
                disabled={busy || (ledger?.agreements.length ?? 0) === 0}
                aria-busy={busyAction === 'opc-receipt-confirm'}
              >
                {busyAction === 'opc-receipt-confirm' ? 'Đang xác nhận…' : 'Xác nhận phiếu thu'}
              </button>
            </form>
          </div>

          <div>
            <h3 className="section-subhead">Phiếu thu ({ledger?.receipts.length ?? 0})</h3>
            {ledger !== null && ledger.receipts.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Tham chiếu</th>
                      <th scope="col">Loại phí</th>
                      <th scope="col" className="num">Thực thu</th>
                      <th scope="col">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.receipts.map((rc) => (
                      <tr key={rc.id}>
                        <td>{rc.reference}</td>
                        <td>{FEE_LABELS[rc.fee_type] ?? rc.fee_type}</td>
                        <td className="num money">{formatVndWithUnit(rc.amount_vnd)}</td>
                        <td>
                          <span className={founderBadgeClass(rc.status)}>{rc.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="section-subhead">Pilot credit ({ledger?.pilotCredits.length ?? 0})</h3>
            {ledger !== null && ledger.pilotCredits.length > 0 && (
              <ul className="field__hint">
                {ledger.pilotCredits.map((c) => (
                  <li key={c.id}>
                    {formatVndWithUnit(c.credit_amount_vnd)} —{' '}
                    {c.applied_to_obligation_id === null
                      ? 'chưa dùng (dùng một lần)'
                      : `đã khấu trừ vào ${c.applied_to_obligation_id}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
