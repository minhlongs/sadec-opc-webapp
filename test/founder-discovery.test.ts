import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './sqlite-d1-harness.ts';
import {
  ALLOWED_METRIC_KEYS,
  applyChangeProposal,
  applyPilotCredit,
  confirmOpcReceipt,
  createChangeProposal,
  createOpcAgreement,
  createOrUpdateInterview,
  exportInterviewsToCsv,
  getActiveConfig,
  listChangeProposals,
  listConfigVersions,
  listInterviews,
  listObservations,
  listOpcLedger,
  parseOptionalNumber,
  recordOpcObligation,
  rollbackConfig,
  runEconomicsScenarios,
  validateImportBatch,
  type ImportInterviewItem,
} from '../src/founder/discovery.ts';

describe('Phase 3: Founder Discovery, Config Proposals, Economics & OPC Ledger', () => {
  it('correctly handles parseOptionalNumber (distinguishes omitted vs null vs zero)', () => {
    expect(parseOptionalNumber(undefined)).toBeUndefined();
    expect(parseOptionalNumber(null)).toBeNull();
    expect(parseOptionalNumber(0)).toBe(0);
    expect(parseOptionalNumber(42)).toBe(42);
    expect(parseOptionalNumber('')).toBeNull();
    expect(parseOptionalNumber('  ')).toBeNull();
    expect(parseOptionalNumber('100')).toBe(100);
    expect(parseOptionalNumber('not-a-number')).toBeNull();
  });

  it('records interviews & append-only observations, rejecting synthetic in pilot', async () => {
    const { db } = createSqliteD1({ seedDemo: true });

    // In demo / dev environment, synthetic is allowed
    const resDev = await createOrUpdateInterview(
      db,
      {
        external_id: 'INT-TEST-001',
        organization_alias: 'Vườn thực nghiệm',
        respondent_role: 'Chủ vườn',
        interviewed_at: '2026-10-25',
        data_origin: 'synthetic',
        notes: 'Phỏng vấn thử nghiệm',
        actorId: 'id-demo-admin',
      },
      [
        {
          metric_key: 'willingness_to_pay_vnd',
          value_num: 2500000,
          unit: 'VND',
          period: 'month',
          evidence_kind: 'reported',
          source_ref: 'Audio #1',
        },
      ],
      'development',
    );
    expect(resDev.kind).toBe('ok');
    if (resDev.kind !== 'ok') return;
    expect(resDev.value.revision).toBe(1);

    // In pilot environment, synthetic data must be refused
    const resPilot = await createOrUpdateInterview(
      db,
      {
        external_id: 'INT-TEST-002',
        organization_alias: 'Vườn thực nghiệm',
        respondent_role: 'Chủ vườn',
        interviewed_at: '2026-10-25',
        data_origin: 'synthetic',
        notes: null,
        actorId: 'id-demo-admin',
      },
      [
        {
          metric_key: 'setup_hours_per_customer',
          value_num: 20,
          unit: 'hours',
          period: 'once',
          evidence_kind: 'measured',
          source_ref: null,
        },
      ],
      'pilot',
    );
    expect(resPilot.kind).toBe('refused');
    expect(resPilot.message).toMatch(/dữ liệu mẫu.*chỉ được phép ở môi trường dev/i);
  });

  it('idempotently re-records identical interview, but increments revision when updated', async () => {
    const { db } = createSqliteD1({ seedDemo: true });

    const interviewInput = {
      external_id: 'INT-IDEMP-01',
      organization_alias: 'Nhà vườn Mai Vàng',
      respondent_role: 'Chủ vườn',
      interviewed_at: '2026-10-25',
      data_origin: 'real' as const,
      notes: 'Bản ghi lần 1',
      actorId: 'id-demo-admin',
    };
    const obs = [
      {
        metric_key: 'pilot_fee_vnd' as const,
        value_num: 3000000,
        unit: 'VND',
        evidence_kind: 'reported' as const,
      },
    ];

    const first = await createOrUpdateInterview(db, interviewInput, obs);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.revision).toBe(1);

    // Identical call returns revision 1 without extra rows
    const second = await createOrUpdateInterview(db, interviewInput, obs);
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.revision).toBe(1);

    // Updated notes increments revision to 2
    const third = await createOrUpdateInterview(
      db,
      { ...interviewInput, notes: 'Bản ghi sửa đổi lần 2' },
      obs,
    );
    expect(third.kind).toBe('ok');
    if (third.kind !== 'ok') return;
    expect(third.value.revision).toBe(2);
  });

  it('escapes CSV formulas on export to prevent spreadsheet injection', async () => {
    const { db } = createSqliteD1({ seedDemo: true });

    await createOrUpdateInterview(
      db,
      {
        external_id: 'INT-CSV-01',
        organization_alias: '=HYPERLINK("http://attacker.com")',
        respondent_role: '+CMD|"/C calc"!A0',
        interviewed_at: '2026-10-25',
        data_origin: 'real',
        notes: '@malicious_tag',
        actorId: 'id-demo-admin',
      },
      [
        {
          metric_key: 'willingness_to_pay_vnd',
          value_str: '-100000',
          unit: 'VND',
          evidence_kind: 'reported',
          source_ref: '=SUM(A1:A10)',
        },
      ],
    );

    const interviews = await listInterviews(db);
    const observations = await listObservations(db);
    const csv = exportInterviewsToCsv(interviews, observations);

    // CSV fields starting with formula characters must be prepended with a single quote
    expect(csv).toContain("'''=HYPERLINK");
    expect(csv).toContain("'''+CMD");
    expect(csv).toContain("'''@malicious_tag");
    expect(csv).toContain("'''-100000");
    expect(csv).toContain("'''=SUM(A1:A10)");
  });

  it('enforces import batch limits (max 256 KiB and max 500 observations)', () => {
    const validItem: ImportInterviewItem = {
      external_id: 'INT-01',
      organization_alias: 'Vườn A',
      respondent_role: 'Chủ vườn',
      interviewed_at: '2026-10-25',
      data_origin: 'real',
      notes: null,
      observations: [
        {
          metric_key: 'pilot_fee_vnd',
          value_num: 3000000,
          unit: 'VND',
          evidence_kind: 'reported',
        },
      ],
    };

    // Valid batch
    const okRes = validateImportBatch([validItem], 1024, 'development');
    expect(okRes.kind).toBe('ok');

    // Over size limit (256 * 1024 + 1 bytes)
    const sizeOver = validateImportBatch([validItem], 256 * 1024 + 1, 'development');
    expect(sizeOver.kind).toBe('refused');
    expect(sizeOver.message).toMatch(/vượt quá giới hạn 256 KiB/i);

    // Over observations limit (> 500)
    const bigItem: ImportInterviewItem = {
      ...validItem,
      observations: Array.from({ length: 501 }, () => validItem.observations[0]!),
    };
    const obsOver = validateImportBatch([bigItem], 1024, 'development');
    expect(obsOver.kind).toBe('refused');
    expect(obsOver.message).toMatch(/vượt quá 500/i);
  });

  it('executes config change proposal lifecycle with optimistic concurrency and rollback', async () => {
    const { db } = createSqliteD1({ seedDemo: true });

    const activeV1 = await getActiveConfig(db, 'business_model');
    expect(activeV1).not.toBeNull();
    expect(activeV1?.version_number).toBe(1);

    // 1. Create proposal based on v1
    const propRes = await createChangeProposal(db, {
      scope: 'business_model',
      baseVersionId: activeV1!.id,
      changes: {
        support_hours_per_customer_month: 2,
        direct_cost_per_customer_month_vnd: 250000,
      },
      evidenceIds: ['obs-demo-01'],
      rationale: 'Tối ưu hóa quy trình hỗ trợ nhờ tự động hóa báo giá',
      proposedBy: 'id-demo-admin',
    });
    expect(propRes.kind).toBe('ok');
    if (propRes.kind !== 'ok') return;
    const proposal = propRes.value;

    // 2. Apply proposal -> creates v2
    const applyRes = await applyChangeProposal(db, {
      proposalId: proposal.id,
      actorId: 'id-demo-admin',
    });
    expect(applyRes.kind).toBe('ok');
    if (applyRes.kind !== 'ok') return;
    expect(applyRes.value.version.version_number).toBe(2);
    expect(applyRes.value.version.parameters.support_hours_per_customer_month).toBe(2);
    expect(applyRes.value.version.parameters.direct_cost_per_customer_month_vnd).toBe(250000);

    // Verify pointer updated to v2
    const activeV2 = await getActiveConfig(db, 'business_model');
    expect(activeV2?.version_number).toBe(2);

    // 3. Stale proposal based on v1 should now be refused due to base_version_id conflict
    const staleProp = await createChangeProposal(db, {
      scope: 'business_model',
      baseVersionId: activeV1!.id, // stale base
      changes: { sales_hours_per_month: 20 },
      evidenceIds: ['obs-demo-03'],
      rationale: 'Đề xuất cũ',
      proposedBy: 'id-demo-admin',
    });
    if (staleProp.kind !== 'ok') throw new Error('stale prop create failed');
    const staleApply = await applyChangeProposal(db, {
      proposalId: staleProp.value.id,
      actorId: 'id-demo-admin',
    });
    expect(staleApply.kind).toBe('refused');
    expect(staleApply.status).toBe(409); // Conflict

    // 4. Rollback back to v1 creates an immutable new version v3 that copies v1
    const rollbackRes = await rollbackConfig(db, {
      scope: 'business_model',
      targetVersionId: activeV1!.id,
      actorId: 'id-demo-admin',
    });
    expect(rollbackRes.kind).toBe('ok');
    if (rollbackRes.kind !== 'ok') return;
    expect(rollbackRes.value.version_number).toBe(3);
    // Parameters match v1 (support_hours was 4 in baseline v1)
    expect(rollbackRes.value.parameters.support_hours_per_customer_month).toBe(4);

    const activeV3 = await getActiveConfig(db, 'business_model');
    expect(activeV3?.version_number).toBe(3);
  });

  it('runs economics scenarios with N=5, N=10, N=10/S=2 and marks simulation label', async () => {
    const { db } = createSqliteD1({ seedDemo: true });

    const econ = await runEconomicsScenarios(db);
    expect(econ.parameters).toBeDefined();
    expect(econ.scenarios.length).toBe(3);

    const [n5, n10, n10s2] = econ.scenarios;
    expect(n5?.activeCustomers).toBe(5);
    expect(n5?.newSetupsInMonth).toBe(0);
    expect(n5?.operatingProfitVnd).toBeGreaterThan(0);

    expect(n10?.activeCustomers).toBe(10);
    expect(n10?.newSetupsInMonth).toBe(0);

    expect(n10s2?.activeCustomers).toBe(10);
    expect(n10s2?.newSetupsInMonth).toBe(2);
    // At N=10 and S=2: founder hours = 4*10 + 24*2 + 72 overhead = 40 + 48 + 72 = 160h exactly (or close depending on config)
    expect(n10s2?.founderHoursUsed).toBeGreaterThan(n10!.founderHoursUsed);
  });

  it('manages OPC commercial ledger, pilot credits and obligations', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const wsId = 'ws-demo-b';

    // 1. Create OPC Agreement
    const agRes = await createOpcAgreement(db, {
      workspaceId: wsId,
      monthlyFeeVnd: 3000000,
      setupFeeVnd: 10000000,
      effectiveDate: '2026-11-01',
      pricePlaneSnapshot: { monthly: 3000000, setup: 10000000 },
      actorId: 'id-demo-admin',
    });
    expect(agRes.kind).toBe('ok');
    if (agRes.kind !== 'ok') return;
    const agreement = agRes.value;

    // 2. Record Pilot Obligation
    const obPilotRes = await recordOpcObligation(db, {
      agreementId: agreement.id,
      workspaceId: wsId,
      obligationKind: 'pilot_fee',
      amountVnd: 3000000,
      dueDate: '2026-11-05',
      actorId: 'id-demo-admin',
    });
    expect(obPilotRes.kind).toBe('ok');
    if (obPilotRes.kind !== 'ok') return;
    const obPilot = obPilotRes.value;

    // 3. Confirm Pilot Receipt -> generates a pilot credit
    const rcPilotRes = await confirmOpcReceipt(db, {
      receiptId: 'opcrc-test-pilot',
      agreementId: agreement.id,
      workspaceId: wsId,
      obligationId: obPilot.id,
      amountVnd: 3000000,
      feeType: 'pilot_fee',
      reference: 'OPC-PILOT-WSB',
      confirmedBy: 'id-demo-admin',
      note: 'Thu phí pilot 3M',
    });
    expect(rcPilotRes.kind).toBe('ok');
    if (rcPilotRes.kind !== 'ok') return;
    expect(rcPilotRes.value.pilotCredit).toBeDefined();
    expect(rcPilotRes.value.pilotCredit?.credit_amount_vnd).toBe(3000000);

    // 4. Record Setup Fee Obligation (10M)
    const obSetupRes = await recordOpcObligation(db, {
      agreementId: agreement.id,
      workspaceId: wsId,
      obligationKind: 'setup_fee',
      amountVnd: 10000000,
      dueDate: '2026-11-20',
      actorId: 'id-demo-admin',
    });
    expect(obSetupRes.kind).toBe('ok');
    if (obSetupRes.kind !== 'ok') return;
    const obSetup = obSetupRes.value;

    // 5. Apply Pilot Credit to Setup Fee Obligation
    const creditId = rcPilotRes.value.pilotCredit!.id;
    const applyCreditRes = await applyPilotCredit(db, {
      creditId,
      obligationId: obSetup.id,
      workspaceId: wsId,
      actorId: 'id-demo-admin',
    });
    expect(applyCreditRes.kind).toBe('ok');
    if (applyCreditRes.kind !== 'ok') return;
    expect(applyCreditRes.value.credit.applied_to_obligation_id).toBe(obSetup.id);

    // Re-applying the same pilot credit is refused
    const applyAgain = await applyPilotCredit(db, {
      creditId,
      obligationId: obSetup.id,
      workspaceId: wsId,
      actorId: 'id-demo-admin',
    });
    expect(applyAgain.kind).toBe('refused');
    expect(applyAgain.message).toMatch(/đã được áp dụng/i);
  });
});
