/**
 * Phase 3 — Founder routes: interviews, observations, config proposals/versions,
 * economics scenarios, and OPC commercial ledger.
 *
 * Every route here is guarded by `authorize` in the Worker entry using
 * `founder.parameter.read` or `founder.parameter.publish` (plus `workspace.setting.write`
 * for tenant-scoped operational settings).
 */

import { z } from 'zod';
import {
  ALLOWED_METRIC_KEYS,
  CONFIG_SCOPES,
  EVIDENCE_KINDS,
  OPC_FEE_TYPES,
  OPC_OBLIGATION_KINDS,
  applyChangeProposal,
  applyPilotCredit,
  confirmOpcReceipt,
  createChangeProposal,
  createInitialConfigVersion,
  createOpcAgreement,
  createOrUpdateInterview,
  executeImportPlan,
  exportInterviewsToCsv,
  getActiveConfig,
  listChangeProposals,
  listConfigVersions,
  listInterviews,
  listObservations,
  listOpcLedger,
  planInterviewImport,
  recordOpcObligation,
  rollbackConfig,
  runEconomicsScenarios,
  type ImportInterviewItem,
  type ImportPlan,
  type MetricKey,
} from './discovery.ts';
import { computeScenario } from '../domain/economics.ts';
import { apiError } from '../ops/routes.ts';
import { refusalResponse } from '../ops/api-error.ts';
import type { D1Like } from '../ops/catalog.ts';
import type { Role } from '../security/authorize.ts';

export interface FounderRequestContext {
  workspaceId: string;
  actorId: string;
  role: Role;
  db: D1Like;
  appEnv?: string;
  /**
   * Workspaces where the caller may perform the current action, as the
   * chokepoint resolved them from live memberships. Founder routes take a
   * `target_workspace_id` so a founder can act on a nursery's ledger from
   * their own seat — but only on nurseries they administer.
   */
  accessibleWorkspaceIds: () => Promise<readonly string[]>;
  /** True iff `workspaceId` is in `accessibleWorkspaceIds()`. */
  authorizeWorkspace: (workspaceId: string) => Promise<boolean>;
}

/**
 * Resolves the workspace a founder write targets: the requested one if the
 * caller administers it, else the chokepoint's workspace. A request naming a
 * workspace is a selection, never evidence; the denial carries the same
 * message as any other refusal so it says nothing about what exists.
 */
async function resolveTargetWorkspace(
  ctx: FounderRequestContext,
  requested: string | undefined,
): Promise<{ ok: true; workspaceId: string } | { ok: false; response: Response }> {
  const workspaceId = requested ?? ctx.workspaceId;
  if (workspaceId !== ctx.workspaceId && !(await ctx.authorizeWorkspace(workspaceId))) {
    return {
      ok: false,
      response: apiError('Bạn không có quyền thao tác trên không gian làm việc này.', 403, 'forbidden'),
    };
  }
  return { ok: true, workspaceId };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'Dữ liệu không hợp lệ.';
  const field = issue.path.join('.');
  return field === ''
    ? `Dữ liệu không hợp lệ: ${issue.message}`
    : `Dữ liệu không hợp lệ ở "${field}": ${issue.message}`;
}

const observationSchema = z.object({
  metric_key: z.enum(ALLOWED_METRIC_KEYS),
  value_num: z.number().finite().nullish(),
  value_str: z.string().trim().max(500).nullish(),
  unit: z.string().trim().min(1).max(40),
  period: z.string().trim().max(40).nullish(),
  evidence_kind: z.enum(EVIDENCE_KINDS),
  source_ref: z.string().trim().max(200).nullish(),
  is_null: z.boolean().optional(),
});

const interviewSchema = z.object({
  external_id: z.string().trim().min(1).max(80),
  organization_alias: z.string().trim().min(1).max(160),
  respondent_role: z.string().trim().min(1).max(120),
  interviewed_at: z.string().trim().min(1).max(40),
  data_origin: z.enum(['synthetic', 'real']),
  notes: z.string().trim().max(2000).nullish(),
  observations: z.array(observationSchema).min(1).max(500),
});

const importBatchSchema = z.object({
  items: z.array(interviewSchema).min(1).max(100),
});

const createProposalSchema = z.object({
  scope: z.enum(CONFIG_SCOPES),
  workspace_id: z.string().trim().max(64).nullish(),
  base_version_id: z.string().trim().max(64).nullish(),
  changes: z.record(z.string(), z.number().finite()),
  evidence_ids: z.array(z.string().trim().min(1).max(64)).max(50),
  rationale: z.string().trim().min(1).max(1000),
});

const applyProposalSchema = z.object({
  proposal_id: z.string().trim().min(1).max(64),
});

const rollbackSchema = z.object({
  scope: z.enum(CONFIG_SCOPES),
  workspace_id: z.string().trim().max(64).nullish(),
  target_version_id: z.string().trim().min(1).max(64),
});

const opcAgreementSchema = z.object({
  target_workspace_id: z.string().trim().min(1).max(64).optional(),
  monthly_fee_vnd: z.number().int().nonnegative(),
  setup_fee_vnd: z.number().int().nonnegative(),
  effective_date: z.string().trim().min(1).max(40),
  price_plane_snapshot: z.record(z.string(), z.unknown()).optional(),
});

const opcObligationSchema = z.object({
  agreement_id: z.string().trim().min(1).max(64),
  target_workspace_id: z.string().trim().min(1).max(64).optional(),
  obligation_kind: z.enum(OPC_OBLIGATION_KINDS),
  amount_vnd: z.number().int().positive(),
  due_date: z.string().trim().min(1).max(40),
});

const opcReceiptConfirmSchema = z.object({
  receipt_id: z.string().trim().max(64).optional(),
  agreement_id: z.string().trim().min(1).max(64),
  target_workspace_id: z.string().trim().min(1).max(64).optional(),
  obligation_id: z.string().trim().max(64).nullish(),
  amount_vnd: z.number().int().positive(),
  fee_type: z.enum(OPC_FEE_TYPES),
  reference: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).nullish(),
});

const applyPilotCreditSchema = z.object({
  credit_id: z.string().trim().min(1).max(64),
  obligation_id: z.string().trim().min(1).max(64),
  target_workspace_id: z.string().trim().min(1).max(64).optional(),
});

export async function handleListInterviews(ctx: FounderRequestContext): Promise<Response> {
  const interviews = await listInterviews(ctx.db);
  const observations = await listObservations(ctx.db);
  return json({ interviews, observations });
}

export async function handleCreateOrUpdateInterview(
  ctx: FounderRequestContext,
  body: unknown,
): Promise<Response> {
  const parsed = interviewSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  const d = parsed.data;
  const result = await createOrUpdateInterview(
    ctx.db,
    {
      external_id: d.external_id,
      organization_alias: d.organization_alias,
      respondent_role: d.respondent_role,
      interviewed_at: d.interviewed_at,
      data_origin: d.data_origin,
      notes: d.notes ?? null,
      actorId: ctx.actorId,
    },
    d.observations.map((o) => ({
      metric_key: o.metric_key as MetricKey,
      value_num: o.value_num ?? null,
      value_str: o.value_str ?? null,
      unit: o.unit,
      period: o.period ?? null,
      evidence_kind: o.evidence_kind,
      source_ref: o.source_ref ?? null,
      is_null: o.is_null,
    })),
    ctx.appEnv,
  );

  if (result.kind === 'refused') return refusalResponse(result);
  return json(result.value, 201);
}

function importItemsFrom(parsed: z.infer<typeof importBatchSchema>): ImportInterviewItem[] {
  return parsed.items.map((item) => ({
    external_id: item.external_id,
    organization_alias: item.organization_alias,
    respondent_role: item.respondent_role,
    interviewed_at: item.interviewed_at,
    data_origin: item.data_origin,
    notes: item.notes ?? null,
    observations: item.observations.map((o) => ({
      metric_key: o.metric_key as MetricKey,
      value_num: o.value_num ?? null,
      value_str: o.value_str ?? null,
      unit: o.unit,
      period: o.period ?? null,
      evidence_kind: o.evidence_kind,
      source_ref: o.source_ref ?? null,
      is_null: o.is_null,
    })),
  }));
}

function importSummary(plan: ImportPlan) {
  return {
    interviews_count: plan.interviewsCount,
    observations_count: plan.observationsCount,
    create_count: plan.createCount,
    revision_count: plan.reviseCount,
    unchanged_count: plan.unchangedCount,
    items: plan.items.map((item) => ({
      external_id: item.external_id,
      action: item.action,
      revision: item.interview.revision,
      observations_count: item.observations.length,
    })),
  };
}

/**
 * Preview is the plan without the batch: the same reads and the same checks
 * apply will make, and no statement that writes. It reports what apply would
 * do per interview — create, revise or leave unchanged.
 */
export async function handlePreviewImportInterviews(
  ctx: FounderRequestContext,
  body: unknown,
  rawByteLength: number,
): Promise<Response> {
  const parsed = importBatchSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  const planned = await planInterviewImport(
    ctx.db,
    importItemsFrom(parsed.data),
    ctx.actorId,
    ctx.appEnv,
    rawByteLength,
  );
  if (planned.kind === 'refused') return refusalResponse(planned);

  return json({ preview: { ...importSummary(planned.value), valid: true } });
}

/**
 * Apply re-plans from fresh reads — a preview's answer is never trusted as
 * the state of the database — and executes the plan as one transaction. A
 * batch that cannot be applied whole is not applied at all.
 */
export async function handleApplyImportInterviews(
  ctx: FounderRequestContext,
  body: unknown,
  rawByteLength: number,
): Promise<Response> {
  const parsed = importBatchSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  const planned = await planInterviewImport(
    ctx.db,
    importItemsFrom(parsed.data),
    ctx.actorId,
    ctx.appEnv,
    rawByteLength,
  );
  if (planned.kind === 'refused') return refusalResponse(planned);

  const executed = await executeImportPlan(ctx.db, planned.value, {
    action: 'founder.interviews.imported',
    workspaceId: null,
  });
  if (executed.kind === 'refused') return refusalResponse(executed);

  return json(
    {
      applied_count: planned.value.createCount + planned.value.reviseCount,
      audit_id: executed.value.auditId,
      ...importSummary(planned.value),
      items: executed.value.items.map((item) => ({
        ...item.interview,
        interview: item.interview,
        observations: item.observations,
        action: item.action,
        wasRevision: item.action === 'revise',
      })),
    },
    201,
  );
}

export async function handleExportInterviews(
  ctx: FounderRequestContext,
  searchParams: URLSearchParams,
): Promise<Response> {
  const interviews = await listInterviews(ctx.db);
  const observations = await listObservations(ctx.db);
  const format = (searchParams.get('format') ?? 'csv').toLowerCase();

  if (format === 'json') {
    return json({ interviews, observations });
  }

  const csv = exportInterviewsToCsv(interviews, observations);
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="founder-interviews.csv"',
    },
  });
}

export async function handleGetConfigAndProposals(
  ctx: FounderRequestContext,
): Promise<Response> {
  let active = await getActiveConfig(ctx.db, 'business_model');
  if (active === null) {
    // Auto-bootstrap baseline version 1 if none exists yet. The insert is
    // conditional on no pointer existing, so two first readers racing here
    // produce one version; whoever lost simply reads it back.
    const scenarioData = await runEconomicsScenarios(ctx.db);
    await createInitialConfigVersion(
      ctx.db,
      'business_model',
      null,
      scenarioData.parameters,
      ctx.actorId,
    );
    active = await getActiveConfig(ctx.db, 'business_model');
  }

  const versions = await listConfigVersions(ctx.db, 'business_model');
  const proposals = await listChangeProposals(ctx.db, 'business_model');

  return json({
    active_version: active?.version ?? null,
    active_parameters: active?.parameters ?? null,
    versions,
    proposals,
  });
}

export async function handleCreateProposal(
  ctx: FounderRequestContext,
  body: unknown,
): Promise<Response> {
  const parsed = createProposalSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  const d = parsed.data;
  let workspaceId: string | null = null;
  if (d.scope === 'workspace_operations') {
    const target = await resolveTargetWorkspace(ctx, d.workspace_id ?? undefined);
    if (!target.ok) return target.response;
    workspaceId = target.workspaceId;
  }
  const result = await createChangeProposal(ctx.db, {
    scope: d.scope,
    workspaceId,
    baseVersionId: d.base_version_id ?? null,
    changes: d.changes,
    evidenceIds: d.evidence_ids,
    rationale: d.rationale,
    proposedBy: ctx.actorId,
  });

  if (result.kind === 'refused') return refusalResponse(result);
  return json({ proposal: result.value }, 201);
}

export async function handleApplyProposal(
  ctx: FounderRequestContext,
  body: unknown,
): Promise<Response> {
  const parsed = applyProposalSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  // A tenant-scoped proposal is applied in its own workspace, which the caller
  // must administer; the request names only the proposal, so the workspace is
  // read from the record and checked at the chokepoint, not taken on trust.
  const owner = await ctx.db
    .prepare(`SELECT scope, workspace_id FROM change_proposals WHERE id = ?`)
    .bind(parsed.data.proposal_id)
    .first<{ scope: string; workspace_id: string | null }>();
  if (owner === null) return apiError('Không tìm thấy đề xuất thay đổi.', 404, 'not_found');
  if (owner.scope === 'workspace_operations') {
    const target = await resolveTargetWorkspace(ctx, owner.workspace_id ?? undefined);
    if (!target.ok) return target.response;
  }

  const result = await applyChangeProposal(ctx.db, {
    proposalId: parsed.data.proposal_id,
    actorId: ctx.actorId,
  });

  if (result.kind === 'refused') return refusalResponse(result);
  return json(result.value);
}

export async function handleRollbackConfig(
  ctx: FounderRequestContext,
  body: unknown,
): Promise<Response> {
  const parsed = rollbackSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  const d = parsed.data;
  let workspaceId: string | null = null;
  if (d.scope === 'workspace_operations') {
    const target = await resolveTargetWorkspace(ctx, d.workspace_id ?? undefined);
    if (!target.ok) return target.response;
    workspaceId = target.workspaceId;
  }
  const result = await rollbackConfig(ctx.db, {
    scope: d.scope,
    workspaceId,
    targetVersionId: d.target_version_id,
    actorId: ctx.actorId,
  });

  if (result.kind === 'refused') return refusalResponse(result);
  return json({ version: result.value });
}

export async function handleRunEconomics(
  ctx: FounderRequestContext,
  searchParams: URLSearchParams,
): Promise<Response> {
  const base = await runEconomicsScenarios(ctx.db);
  const customN = searchParams.get('n');
  const customS = searchParams.get('s');

  let customScenario = null;
  if (customN !== null) {
    const nVal = Number(customN);
    const sVal = customS !== null ? Number(customS) : 0;
    if (Number.isInteger(nVal) && nVal >= 0 && Number.isInteger(sVal) && sVal >= 0) {
      customScenario = computeScenario(base.parameters, nVal, sVal);
    }
  }

  return json({
    label: 'SCENARIO_SIMULATION — Dữ liệu mô phỏng kịch bản (tách biệt với số thực thu)',
    parameters: base.parameters,
    parameters_source: base.parameters_source,
    assumptions: [
      'Mọi số tiền là mô phỏng từ tham số cấu hình; không phải doanh thu, phí hay tiền đã thu.',
      'Doanh thu kịch bản = N × monthly_fee_vnd + S × setup_fee_vnd; chi phí tiền mặt = N × direct_cost_per_customer_month_vnd + S × direct_cost_per_setup_vnd + fixed_cost_per_month_vnd (src/domain/economics.ts).',
      'Giờ công sáng lập được quy đổi theo founder_hourly_value_vnd; vượt capacity_hours_per_month là cảnh báo công suất, không phải chi phí phát sinh.',
      base.parameters_source.kind === 'config_version'
        ? `Tham số lấy từ phiên bản cấu hình v${base.parameters_source.version_number} (${base.parameters_source.version_id}).`
        : base.parameters_source.note,
    ],
    scenarios: base.scenarios,
    custom_scenario: customScenario ? { ...customScenario, parameters_source: base.parameters_source } : null,
  });
}

export async function handleListOpcLedger(
  ctx: FounderRequestContext,
  searchParams: URLSearchParams,
): Promise<Response> {
  const accessible = await ctx.accessibleWorkspaceIds();
  const filterWs = searchParams.get('target_workspace_id');
  if (filterWs !== null && !accessible.includes(filterWs)) {
    return apiError('Bạn không có quyền xem sổ cái của không gian làm việc này.', 403, 'forbidden');
  }
  const ledger = await listOpcLedger(ctx.db, filterWs ?? accessible);
  return json(ledger);
}

export async function handleCreateOpcAgreement(
  ctx: FounderRequestContext,
  body: unknown,
): Promise<Response> {
  const parsed = opcAgreementSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  const d = parsed.data;
  const target = await resolveTargetWorkspace(ctx, d.target_workspace_id);
  if (!target.ok) return target.response;
  const result = await createOpcAgreement(ctx.db, {
    workspaceId: target.workspaceId,
    monthlyFeeVnd: d.monthly_fee_vnd,
    setupFeeVnd: d.setup_fee_vnd,
    effectiveDate: d.effective_date,
    pricePlaneSnapshot: d.price_plane_snapshot ?? {
      monthly_fee_vnd: d.monthly_fee_vnd,
      setup_fee_vnd: d.setup_fee_vnd,
    },
    actorId: ctx.actorId,
  });

  if (result.kind === 'refused') return refusalResponse(result);
  return json({ agreement: result.value }, 201);
}

export async function handleRecordOpcObligation(
  ctx: FounderRequestContext,
  body: unknown,
): Promise<Response> {
  const parsed = opcObligationSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  const d = parsed.data;
  const target = await resolveTargetWorkspace(ctx, d.target_workspace_id);
  if (!target.ok) return target.response;
  const result = await recordOpcObligation(ctx.db, {
    agreementId: d.agreement_id,
    workspaceId: target.workspaceId,
    obligationKind: d.obligation_kind,
    amountVnd: d.amount_vnd,
    dueDate: d.due_date,
    actorId: ctx.actorId,
  });

  if (result.kind === 'refused') return refusalResponse(result);
  return json({ obligation: result.value }, 201);
}

export async function handleConfirmOpcReceipt(
  ctx: FounderRequestContext,
  body: unknown,
): Promise<Response> {
  const parsed = opcReceiptConfirmSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  const d = parsed.data;
  const target = await resolveTargetWorkspace(ctx, d.target_workspace_id);
  if (!target.ok) return target.response;
  const result = await confirmOpcReceipt(ctx.db, {
    receiptId: d.receipt_id ?? '',
    agreementId: d.agreement_id,
    workspaceId: target.workspaceId,
    obligationId: d.obligation_id ?? null,
    amountVnd: d.amount_vnd,
    feeType: d.fee_type,
    reference: d.reference,
    confirmedBy: ctx.actorId,
    note: d.note ?? null,
  });

  if (result.kind === 'refused') return refusalResponse(result);
  return json(result.value, 201);
}

export async function handleApplyPilotCredit(
  ctx: FounderRequestContext,
  body: unknown,
): Promise<Response> {
  const parsed = applyPilotCreditSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400, 'validation');

  const d = parsed.data;
  const target = await resolveTargetWorkspace(ctx, d.target_workspace_id);
  if (!target.ok) return target.response;
  const result = await applyPilotCredit(ctx.db, {
    creditId: d.credit_id,
    obligationId: d.obligation_id,
    workspaceId: target.workspaceId,
    actorId: ctx.actorId,
  });

  if (result.kind === 'refused') return refusalResponse(result);
  return json(result.value);
}
