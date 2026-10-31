/**
 * Phase 3 — Founder discovery engine, configuration versions, and OPC commercial ledger.
 *
 * Enforces the three-layer separation:
 *   1. Observations from founder interviews (append-only, immutable source revisions)
 *   2. Change Proposals (scope: business_model [global] vs workspace_operations [tenant])
 *   3. Immutable Config Versions with active config pointers and optimistic concurrency
 *
 * Plus the OPC Commercial Ledger:
 *   - Agreements, obligations, pilot credits (single-use), and receipts
 *   - Strict calculation of collected cash, active MRR, and outstanding receivables
 */

import { addVnd, assertSafeVnd } from '../domain/money.ts';
import {
  assertValidParameters,
  type BusinessModelParameters,
} from '../domain/parameters.ts';
import { computeScenario, type ScenarioResult } from '../domain/economics.ts';
import type { D1Like } from '../ops/catalog.ts';
import type { ApiErrorCode } from '../ops/api-error.ts';

/** The 16 metric keys permitted in founder observations (§10). */
export const ALLOWED_METRIC_KEYS = [
  'pilot_fee_vnd',
  'setup_fee_vnd',
  'monthly_fee_vnd',
  'direct_cost_per_customer_month_vnd',
  'direct_cost_per_setup_vnd',
  'fixed_cost_per_month_vnd',
  'founder_hourly_value_vnd',
  'support_hours_per_customer_month',
  'setup_hours_per_customer',
  'sales_hours_per_month',
  'maintenance_hours_per_month',
  'admin_hours_per_month',
  'buffer_hours_per_month',
  'capacity_hours_per_month',
  'minimum_benefit_cost_ratio',
  'willingness_to_pay_vnd',
] as const;

export type MetricKey = (typeof ALLOWED_METRIC_KEYS)[number];

export const EVIDENCE_KINDS = ['reported', 'measured', 'assumption'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const CONFIG_SCOPES = ['business_model', 'workspace_operations'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export const PROPOSAL_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'applied',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const OPC_AGREEMENT_STATUSES = ['draft', 'active', 'terminated'] as const;
export type OpcAgreementStatus = (typeof OPC_AGREEMENT_STATUSES)[number];

export const OPC_OBLIGATION_KINDS = [
  'pilot_fee',
  'setup_fee',
  'monthly_subscription',
  'service_fee',
] as const;
export type OpcObligationKind = (typeof OPC_OBLIGATION_KINDS)[number];

export const OPC_OBLIGATION_STATUSES = [
  'pending',
  'partially_settled',
  'settled',
  'cancelled',
] as const;
export type OpcObligationStatus = (typeof OPC_OBLIGATION_STATUSES)[number];

export const OPC_RECEIPT_STATUSES = ['pending', 'confirmed', 'reversed'] as const;
export type OpcReceiptStatus = (typeof OPC_RECEIPT_STATUSES)[number];

export const OPC_FEE_TYPES = [
  'pilot_fee',
  'setup_fee',
  'monthly_subscription',
  'upgrade_fee',
  'other',
] as const;
export type OpcFeeType = (typeof OPC_FEE_TYPES)[number];

export interface FounderInterviewRow {
  id: string;
  external_id: string;
  organization_alias: string;
  respondent_role: string;
  interviewed_at: string;
  data_origin: 'synthetic' | 'real';
  notes: string | null;
  recorded_by: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface FounderObservationRow {
  id: string;
  interview_id: string;
  metric_key: string;
  value_num: number | null;
  value_str: string | null;
  unit: string;
  period: string | null;
  evidence_kind: string;
  source_ref: string | null;
  is_null: number;
  revision: number;
  created_at: string;
}

export interface ConfigVersionRow {
  id: string;
  scope: string;
  workspace_id: string | null;
  version_number: number;
  parameters_json: string;
  proposal_id: string | null;
  created_by: string;
  created_at: string;
  /** Set on a version created by rollback: the version whose parameters it copies. */
  restored_from_version_id: string | null;
}

export interface ChangeProposalRow {
  id: string;
  scope: string;
  workspace_id: string | null;
  base_version_id: string | null;
  changes_json: string;
  evidence_ids_json: string;
  rationale: string;
  status: string;
  proposed_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpcAgreementRow {
  id: string;
  workspace_id: string;
  status: string;
  monthly_fee_vnd: number;
  setup_fee_vnd: number;
  effective_date: string;
  termination_date: string | null;
  price_plane_snapshot_json: string;
  created_at: string;
  updated_at: string;
}

export interface OpcObligationRow {
  id: string;
  agreement_id: string;
  workspace_id: string;
  obligation_kind: string;
  amount_vnd: number;
  due_date: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface OpcReceiptRow {
  id: string;
  agreement_id: string;
  workspace_id: string;
  obligation_id: string | null;
  amount_vnd: number;
  fee_type: string;
  reference: string;
  status: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface PilotCreditRow {
  id: string;
  workspace_id: string;
  pilot_receipt_id: string;
  credit_amount_vnd: number;
  applied_to_obligation_id: string | null;
  applied_at: string | null;
  created_at: string;
}

const nowIso = (): string => new Date().toISOString();

const id = (prefix: string): string =>
  `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export interface Outcome<T> {
  kind: 'ok';
  value: T;
  message?: string;
  status?: number;
  code?: never;
}

export interface Refusal {
  kind: 'refused';
  message: string;
  status: number;
  code?: ApiErrorCode;
  value?: never;
}

export type Result<T> = Outcome<T> | Refusal;

function ok<T>(value: T): Outcome<T> {
  return { kind: 'ok', value };
}

function refused(message: string, status: number, code?: ApiErrorCode): Refusal {
  return code === undefined ? { kind: 'refused', message, status } : { kind: 'refused', message, status, code };
}

const GENERIC_CONFLICT_MESSAGE = 'Dữ liệu vừa được thay đổi bởi thao tác khác. Vui lòng tải lại và thử lại.';

/** Reads `changes` from a batch result, treating an unreadable value as zero. */
function changesAt(results: unknown, index: number): number {
  if (!Array.isArray(results)) return 0;
  const entry = results[index] as { meta?: { changes?: unknown } } | undefined;
  const value = entry?.meta?.changes;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Semantics helper §9:
 * - `undefined` means omitted / not provided
 * - `null` means explicitly provided as unknown
 * - `0` is a stated number 0
 * - Empty string `""` or whitespace-only is NEVER coerced to zero.
 */
export type OptionalValue<T> =
  | { state: 'omitted' }
  | { state: 'null' }
  | { state: 'value'; value: T };

export function parseOptionalNumber(input: unknown): number | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  }
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 1. Interviews & Observations                                               */
/* -------------------------------------------------------------------------- */

export interface CreateInterviewInput {
  external_id: string;
  organization_alias: string;
  respondent_role: string;
  interviewed_at: string;
  data_origin: 'synthetic' | 'real';
  notes?: string | null;
  actorId: string;
}

export interface ObservationInput {
  metric_key: MetricKey;
  value_num?: number | null;
  value_str?: string | null;
  unit: string;
  period?: string | null;
  evidence_kind: EvidenceKind;
  source_ref?: string | null;
  is_null?: boolean;
}

/** What applying one imported interview would do. */
export type ImportItemAction = 'create' | 'revise' | 'unchanged';

export interface ImportPlanItem {
  external_id: string;
  action: ImportItemAction;
  /** The interview row as it will read after apply (or reads now, if unchanged). */
  interview: FounderInterviewRow;
  /** The observation rows apply writes; for an unchanged item, the current ones. */
  observations: FounderObservationRow[];
  /** The revision the plan was built against; `null` for a new interview. */
  existingRevision: number | null;
}

/**
 * A dry run of an import. Preview returns it without touching the database;
 * apply rebuilds it from fresh reads and executes it as one transaction, so
 * the two never disagree about what is valid — only about whether it happened.
 */
export interface ImportPlan {
  items: ImportPlanItem[];
  interviewsCount: number;
  observationsCount: number;
  createCount: number;
  reviseCount: number;
  unchangedCount: number;
  actorId: string;
  timestamp: string;
}

function observationMatches(existing: FounderObservationRow, wanted: ObservationInput): boolean {
  const wantedNull = wanted.is_null || (wanted.value_num == null && wanted.value_str == null) ? 1 : 0;
  return (
    existing.metric_key === wanted.metric_key &&
    existing.value_num === (wanted.value_num ?? null) &&
    existing.value_str === (wanted.value_str ?? null) &&
    existing.unit === wanted.unit &&
    (existing.period ?? null) === (wanted.period ?? null) &&
    existing.evidence_kind === wanted.evidence_kind &&
    (existing.source_ref ?? null) === (wanted.source_ref ?? null) &&
    existing.is_null === wantedNull
  );
}

function observationRow(
  interviewId: string,
  revision: number,
  timestamp: string,
  obs: ObservationInput,
): FounderObservationRow {
  return {
    id: id('obs'),
    interview_id: interviewId,
    metric_key: obs.metric_key,
    value_num: obs.value_num ?? null,
    value_str: obs.value_str ?? null,
    unit: obs.unit,
    period: obs.period ?? null,
    evidence_kind: obs.evidence_kind,
    source_ref: obs.source_ref ?? null,
    is_null: obs.is_null || (obs.value_num == null && obs.value_str == null) ? 1 : 0,
    revision,
    created_at: timestamp,
  };
}

/**
 * Builds the plan for a batch of interviews without writing anything.
 *
 * Every check apply will make is made here, against the database as it is
 * now: batch limits, the pilot ban on synthetic data, metric keys, duplicate
 * external ids within the batch, and the one transition that is never allowed
 * (an interview recorded as synthetic becoming real in place). An interview
 * whose incoming data equals its current revision is `unchanged` — the
 * append-only history gains nothing from a copy.
 */
export async function planInterviewImport(
  db: D1Like,
  items: ImportInterviewItem[],
  actorId: string,
  envAppEnv?: string,
  byteLength = 0,
): Promise<Result<ImportPlan>> {
  const validated = validateImportBatch(items, byteLength, envAppEnv);
  if (validated.kind === 'refused') return validated;

  const timestamp = nowIso();
  const planned: ImportPlanItem[] = [];

  for (const item of items) {
    const existing = await db
      .prepare(`SELECT * FROM founder_interviews WHERE external_id = ?`)
      .bind(item.external_id)
      .first<FounderInterviewRow>();

    if (existing === null) {
      const interviewId = id('int');
      const interview: FounderInterviewRow = {
        id: interviewId,
        external_id: item.external_id,
        organization_alias: item.organization_alias,
        respondent_role: item.respondent_role,
        interviewed_at: item.interviewed_at,
        data_origin: item.data_origin,
        notes: item.notes ?? null,
        recorded_by: actorId,
        revision: 1,
        created_at: timestamp,
        updated_at: timestamp,
      };
      planned.push({
        external_id: item.external_id,
        action: 'create',
        interview,
        observations: item.observations.map((o) => observationRow(interviewId, 1, timestamp, o)),
        existingRevision: null,
      });
      continue;
    }

    if (existing.data_origin === 'synthetic' && item.data_origin === 'real') {
      return refused(
        `Phỏng vấn "${item.external_id}" đang là dữ liệu mẫu (synthetic); không được chuyển trực tiếp sang real. Hãy ghi một mã phỏng vấn mới.`,
        400,
        'validation',
      );
    }
    if (existing.data_origin === 'real' && item.data_origin === 'synthetic') {
      return refused(
        `Phỏng vấn "${item.external_id}" là dữ liệu thực; không được ghi đè bằng dữ liệu mẫu.`,
        400,
        'validation',
      );
    }

    const { results: currentObs } = await db
      .prepare(`SELECT * FROM founder_observations WHERE interview_id = ? AND revision = ?`)
      .bind(existing.id, existing.revision)
      .all<FounderObservationRow>();

    const identical =
      existing.organization_alias === item.organization_alias &&
      existing.respondent_role === item.respondent_role &&
      existing.interviewed_at === item.interviewed_at &&
      (existing.notes ?? null) === (item.notes ?? existing.notes ?? null) &&
      currentObs.length === item.observations.length &&
      item.observations.every((o) => currentObs.some((eo) => observationMatches(eo, o)));

    if (identical) {
      planned.push({
        external_id: item.external_id,
        action: 'unchanged',
        interview: existing,
        observations: currentObs,
        existingRevision: existing.revision,
      });
      continue;
    }

    const nextRevision = existing.revision + 1;
    planned.push({
      external_id: item.external_id,
      action: 'revise',
      interview: {
        ...existing,
        organization_alias: item.organization_alias,
        respondent_role: item.respondent_role,
        interviewed_at: item.interviewed_at,
        notes: item.notes ?? existing.notes,
        revision: nextRevision,
        updated_at: timestamp,
      },
      observations: item.observations.map((o) => observationRow(existing.id, nextRevision, timestamp, o)),
      existingRevision: existing.revision,
    });
  }

  return ok({
    items: planned,
    interviewsCount: planned.length,
    observationsCount: validated.value.observationsCount,
    createCount: planned.filter((p) => p.action === 'create').length,
    reviseCount: planned.filter((p) => p.action === 'revise').length,
    unchangedCount: planned.filter((p) => p.action === 'unchanged').length,
    actorId,
    timestamp,
  });
}

/**
 * Executes a plan as one `db.batch`, or not at all.
 *
 * Statement 0 writes the audit event for the import, and it is the gate: its
 * `WHERE` holds only if no interview the plan would create exists yet and
 * every interview the plan read is still at the revision it read. Every other
 * statement writes only where that audit row exists. A plan built against a
 * database that has since moved writes nothing and reports a conflict; a
 * constraint the database raises mid-batch rolls the whole batch back. There
 * is no path on which some interviews of a batch land and others do not.
 */
export async function executeImportPlan(
  db: D1Like,
  plan: ImportPlan,
  audit: { action: string; workspaceId?: string | null },
): Promise<Result<{ auditId: string | null; items: ImportPlanItem[] }>> {
  const writes = plan.items.filter((p) => p.action !== 'unchanged');
  if (writes.length === 0) return ok({ auditId: null, items: plan.items });

  const auditId = id('ae');
  const creates = plan.items.filter((p) => p.action === 'create');
  const guarded = plan.items.filter((p) => p.existingRevision !== null);

  const conditions: string[] = [];
  const conditionParams: unknown[] = [];
  if (creates.length > 0) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM founder_interviews WHERE external_id IN (${creates.map(() => '?').join(', ')}))`,
    );
    conditionParams.push(...creates.map((p) => p.external_id));
  }
  if (guarded.length > 0) {
    conditions.push(
      `(SELECT COUNT(*) FROM founder_interviews WHERE ${guarded
        .map(() => '(id = ? AND revision = ?)')
        .join(' OR ')}) = ${guarded.length}`,
    );
    for (const p of guarded) conditionParams.push(p.interview.id, p.existingRevision);
  }

  const detail = {
    external_ids: plan.items.map((p) => p.external_id),
    create_count: plan.createCount,
    revise_count: plan.reviseCount,
    unchanged_count: plan.unchangedCount,
    observations_count: plan.observationsCount,
  };

  const statements = [
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         SELECT ?, ?, ?, ?, 'founder_interview_batch', ?, ?, ?
          WHERE ${conditions.join(' AND ')}`,
      )
      .bind(
        auditId,
        audit.workspaceId ?? null,
        plan.actorId,
        audit.action,
        auditId,
        JSON.stringify(detail),
        plan.timestamp,
        ...conditionParams,
      ),
  ];

  const gate = `EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`;

  for (const item of writes) {
    const iv = item.interview;
    if (item.action === 'create') {
      statements.push(
        db
          .prepare(
            `INSERT INTO founder_interviews
               (id, external_id, organization_alias, respondent_role, interviewed_at,
                data_origin, notes, recorded_by, revision, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE ${gate}`,
          )
          .bind(
            iv.id,
            iv.external_id,
            iv.organization_alias,
            iv.respondent_role,
            iv.interviewed_at,
            iv.data_origin,
            iv.notes,
            iv.recorded_by,
            iv.revision,
            iv.created_at,
            iv.updated_at,
            auditId,
          ),
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE founder_interviews
                SET organization_alias = ?, respondent_role = ?, interviewed_at = ?,
                    notes = ?, revision = ?, updated_at = ?
              WHERE id = ? AND revision = ? AND ${gate}`,
          )
          .bind(
            iv.organization_alias,
            iv.respondent_role,
            iv.interviewed_at,
            iv.notes,
            iv.revision,
            iv.updated_at,
            iv.id,
            item.existingRevision,
            auditId,
          ),
      );
    }
    for (const obs of item.observations) {
      statements.push(
        db
          .prepare(
            `INSERT INTO founder_observations
               (id, interview_id, metric_key, value_num, value_str, unit, period,
                evidence_kind, source_ref, is_null, revision, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE ${gate}`,
          )
          .bind(
            obs.id,
            obs.interview_id,
            obs.metric_key,
            obs.value_num,
            obs.value_str,
            obs.unit,
            obs.period,
            obs.evidence_kind,
            obs.source_ref,
            obs.is_null,
            obs.revision,
            obs.created_at,
            auditId,
          ),
      );
    }
  }

  const results = await db.batch(statements);
  if (changesAt(results, 0) === 0) {
    const moved: string[] = [];
    for (const item of plan.items) {
      const now = await db
        .prepare(`SELECT revision FROM founder_interviews WHERE external_id = ?`)
        .bind(item.external_id)
        .first<{ revision: number }>();
      const nowRevision = now?.revision ?? null;
      if (nowRevision !== item.existingRevision) moved.push(item.external_id);
    }
    return refused(
      moved.length > 0
        ? `Dữ liệu phỏng vấn đã thay đổi trong lúc nhập (${moved.join(', ')}). Hãy xem trước lại rồi áp dụng.`
        : 'Dữ liệu phỏng vấn đã thay đổi trong lúc nhập. Hãy xem trước lại rồi áp dụng.',
      409,
      'conflict',
    );
  }

  return ok({ auditId, items: plan.items });
}

/**
 * Records one interview with its observations: a new interview, or a new
 * revision of an existing one. This is the one-item form of an import and
 * runs through the same plan and the same single transaction.
 */
export async function createOrUpdateInterview(
  db: D1Like,
  args: CreateInterviewInput,
  observations: ObservationInput[],
  envAppEnv?: string,
): Promise<
  Result<
    FounderInterviewRow & {
      interview: FounderInterviewRow;
      observations: FounderObservationRow[];
      wasRevision: boolean;
    }
  >
> {
  const planned = await planInterviewImport(
    db,
    [
      {
        external_id: args.external_id,
        organization_alias: args.organization_alias,
        respondent_role: args.respondent_role,
        interviewed_at: args.interviewed_at,
        data_origin: args.data_origin,
        notes: args.notes ?? null,
        observations,
      },
    ],
    args.actorId,
    envAppEnv,
  );
  if (planned.kind === 'refused') return planned;

  const executed = await executeImportPlan(db, planned.value, { action: 'founder.interview.recorded' });
  if (executed.kind === 'refused') return executed;

  const item = executed.value.items[0];
  if (item === undefined) return refused('Không đọc lại được phỏng vấn vừa ghi.', 500, 'unavailable');
  return ok({
    ...item.interview,
    interview: item.interview,
    observations: item.observations,
    wasRevision: item.action === 'revise',
  });
}

export async function listInterviews(db: D1Like): Promise<FounderInterviewRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM founder_interviews ORDER BY interviewed_at DESC`)
    .all<FounderInterviewRow>();
  return results;
}

export async function listObservations(
  db: D1Like,
  interviewId?: string,
): Promise<FounderObservationRow[]> {
  if (interviewId) {
    const { results } = await db
      .prepare(`SELECT * FROM founder_observations WHERE interview_id = ? ORDER BY revision DESC, created_at DESC`)
      .bind(interviewId)
      .all<FounderObservationRow>();
    return results;
  }
  const { results } = await db
    .prepare(`SELECT * FROM founder_observations ORDER BY created_at DESC`)
    .all<FounderObservationRow>();
  return results;
}

/* -------------------------------------------------------------------------- */
/* 2. Config Versions, Active Pointers & Change Proposals                     */
/* -------------------------------------------------------------------------- */

export async function getActiveConfig(
  db: D1Like,
  scope: ConfigScope,
  workspaceId: string | null = null,
): Promise<
  (ConfigVersionRow & { version: ConfigVersionRow; parameters: BusinessModelParameters }) | null
> {
  const pointerKey = scope === 'business_model' ? 'global' : (workspaceId ?? 'global');

  const pointer = await db
    .prepare(
      `SELECT active_version_id FROM active_config_pointers WHERE scope = ? AND workspace_id = ?`,
    )
    .bind(scope, pointerKey)
    .first<{ active_version_id: string }>();

  if (pointer === null) return null;

  const version = await db
    .prepare(`SELECT * FROM config_versions WHERE id = ?`)
    .bind(pointer.active_version_id)
    .first<ConfigVersionRow>();

  if (version === null) return null;

  const parameters = JSON.parse(version.parameters_json) as BusinessModelParameters;
  return { ...version, version, parameters };
}

/**
 * Writes version 1 for a scope that has none yet. Both statements are
 * conditional on no pointer existing, so two first readers racing to
 * bootstrap produce one version, not two; the loser reads back the winner's.
 */
export async function createInitialConfigVersion(
  db: D1Like,
  scope: ConfigScope,
  workspaceId: string | null,
  parameters: BusinessModelParameters,
  actorId: string,
): Promise<ConfigVersionRow | null> {
  assertValidParameters(parameters);
  const versionId = id('cv');
  const timestamp = nowIso();
  const pointerKey = scope === 'business_model' ? 'global' : (workspaceId ?? 'global');

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO config_versions
           (id, scope, workspace_id, version_number, parameters_json, proposal_id,
            created_by, created_at, restored_from_version_id)
         SELECT ?, ?, ?, 1, ?, NULL, ?, ?, NULL
          WHERE NOT EXISTS (SELECT 1 FROM active_config_pointers WHERE scope = ? AND workspace_id = ?)`,
      )
      .bind(versionId, scope, workspaceId, JSON.stringify(parameters), actorId, timestamp, scope, pointerKey),
    db
      .prepare(
        `INSERT INTO active_config_pointers
           (scope, workspace_id, active_version_id, updated_at)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM config_versions WHERE id = ?)`,
      )
      .bind(scope, pointerKey, versionId, timestamp, versionId),
  ]);

  if (changesAt(results, 0) === 0) return null;

  return {
    id: versionId,
    scope,
    workspace_id: workspaceId,
    version_number: 1,
    parameters_json: JSON.stringify(parameters),
    proposal_id: null,
    created_by: actorId,
    created_at: timestamp,
    restored_from_version_id: null,
  };
}

export async function createChangeProposal(
  db: D1Like,
  args: {
    scope: ConfigScope;
    workspaceId?: string | null;
    baseVersionId: string | null;
    changes: Partial<BusinessModelParameters>;
    evidenceIds: string[];
    rationale: string;
    proposedBy: string;
  },
): Promise<Result<ChangeProposalRow>> {
  const proposalId = id('cp');
  const timestamp = nowIso();
  const wsId = args.scope === 'business_model' ? null : (args.workspaceId ?? null);

  // A proposal is a claim about the business, so it names what it rests on:
  // at least one recorded observation, each of which must exist, and a reason
  // in the proposer's words. A proposal that cites nothing is not recorded.
  const evidenceIds = [...new Set(args.evidenceIds.map((e) => e.trim()).filter((e) => e !== ''))];
  if (evidenceIds.length === 0) {
    return refused('Đề xuất phải dẫn ít nhất một quan sát làm bằng chứng.', 400, 'validation');
  }
  if (args.rationale.trim() === '') {
    return refused('Đề xuất phải nêu lý do thay đổi.', 400, 'validation');
  }
  if (Object.keys(args.changes).length === 0) {
    return refused('Đề xuất phải thay đổi ít nhất một tham số.', 400, 'validation');
  }
  const { results: known } = await db
    .prepare(
      `SELECT id FROM founder_observations WHERE id IN (${evidenceIds.map(() => '?').join(', ')})`,
    )
    .bind(...evidenceIds)
    .all<{ id: string }>();
  const knownIds = new Set(known.map((k) => k.id));
  const missing = evidenceIds.filter((e) => !knownIds.has(e));
  if (missing.length > 0) {
    return refused(`Bằng chứng không tồn tại: ${missing.join(', ')}.`, 400, 'validation');
  }

  // The base version defaults to what is active now, so every proposal can be
  // checked for staleness when it is applied. A caller naming a base keeps it;
  // apply decides whether it is still current.
  let baseVersionId = args.baseVersionId;
  if (baseVersionId === null) {
    const pointerKey = args.scope === 'business_model' ? 'global' : (wsId ?? 'global');
    const pointer = await db
      .prepare(`SELECT active_version_id FROM active_config_pointers WHERE scope = ? AND workspace_id = ?`)
      .bind(args.scope, pointerKey)
      .first<{ active_version_id: string }>();
    baseVersionId = pointer?.active_version_id ?? null;
  } else {
    const base = await db
      .prepare(`SELECT id FROM config_versions WHERE id = ? AND scope = ?`)
      .bind(baseVersionId, args.scope)
      .first<{ id: string }>();
    if (base === null) {
      return refused('Phiên bản cơ sở của đề xuất không tồn tại.', 404, 'not_found');
    }
  }

  await db
    .prepare(
      `INSERT INTO change_proposals
         (id, scope, workspace_id, base_version_id, changes_json, evidence_ids_json,
          rationale, status, proposed_by, approved_by, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      proposalId,
      args.scope,
      wsId,
      baseVersionId,
      JSON.stringify(args.changes),
      JSON.stringify(evidenceIds),
      args.rationale.trim(),
      args.proposedBy,
      timestamp,
      timestamp,
    )
    .run();

  const created = await db
    .prepare(`SELECT * FROM change_proposals WHERE id = ?`)
    .bind(proposalId)
    .first<ChangeProposalRow>();

  if (created === null) return refused('Không đọc lại được đề xuất thay đổi vừa tạo.', 500, 'unavailable');
  return ok(created);
}

/** The pointer row a scope/workspace pair is filed under. */
function pointerKeyFor(scope: ConfigScope, workspaceId: string | null): string {
  return scope === 'business_model' ? 'global' : (workspaceId ?? 'global');
}

/**
 * Applies a change proposal as one transaction:
 * - the proposal must still be open and its base version must still be the
 *   active one — both checked inside the batch, not only before it;
 * - the merged parameter set is validated;
 * - a new immutable ConfigVersion is inserted (statement 0, the gate);
 * - the active pointer moves, the proposal is marked applied and an audit
 *   event is written — each only where that version row exists.
 * Two founders applying against the same base cannot both win: the second
 * batch inserts nothing and is told whose change it lost to.
 */
export async function applyChangeProposal(
  db: D1Like,
  args: {
    proposalId: string;
    actorId: string;
  },
): Promise<
  Result<{
    proposal: ChangeProposalRow;
    newVersion: ConfigVersionRow & { parameters: BusinessModelParameters };
    version: ConfigVersionRow & { parameters: BusinessModelParameters };
  }>
> {
  const proposal = await db
    .prepare(`SELECT * FROM change_proposals WHERE id = ?`)
    .bind(args.proposalId)
    .first<ChangeProposalRow>();

  if (proposal === null) return refused('Không tìm thấy đề xuất thay đổi.', 404, 'not_found');
  if (proposal.status === 'applied') {
    return refused('Đề xuất này đã được áp dụng trước đó.', 409, 'invalid_state');
  }
  if (proposal.status === 'rejected') {
    return refused('Đề xuất này đã bị từ chối, không thể áp dụng.', 409, 'invalid_state');
  }

  const scope = proposal.scope as ConfigScope;
  const pointerKey = pointerKeyFor(scope, proposal.workspace_id);
  const activePointer = await db
    .prepare(`SELECT active_version_id FROM active_config_pointers WHERE scope = ? AND workspace_id = ?`)
    .bind(proposal.scope, pointerKey)
    .first<{ active_version_id: string }>();

  if (activePointer === null) {
    return refused('Không có cấu hình khởi tạo để áp dụng thay đổi.', 400, 'validation');
  }
  if (proposal.base_version_id !== null && activePointer.active_version_id !== proposal.base_version_id) {
    return refused(
      'Xung đột phiên bản: Cấu hình cơ sở đã bị thay đổi bởi người khác. Vui lòng cập nhật lại đề xuất.',
      409,
      'conflict',
    );
  }

  const activeVersion = await db
    .prepare(`SELECT * FROM config_versions WHERE id = ?`)
    .bind(activePointer.active_version_id)
    .first<ConfigVersionRow>();
  if (activeVersion === null) {
    return refused('Không tìm thấy phiên bản cấu hình hiện tại.', 500, 'unavailable');
  }
  const baseParams = JSON.parse(activeVersion.parameters_json) as BusinessModelParameters;
  const nextVersionNumber = activeVersion.version_number + 1;

  const changes = JSON.parse(proposal.changes_json) as Partial<BusinessModelParameters>;
  const mergedParams: BusinessModelParameters = {
    ...baseParams,
    ...changes,
  };

  try {
    assertValidParameters(mergedParams);
  } catch (err: unknown) {
    return refused(
      `Tham số cấu hình mới không hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
      400,
      'validation',
    );
  }

  const newVersionId = id('cv');
  const timestamp = nowIso();
  const gate = `EXISTS (SELECT 1 FROM config_versions WHERE id = ?)`;

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO config_versions
           (id, scope, workspace_id, version_number, parameters_json, proposal_id,
            created_by, created_at, restored_from_version_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL
          WHERE EXISTS (SELECT 1 FROM change_proposals
                         WHERE id = ? AND status NOT IN ('applied', 'rejected'))
            AND EXISTS (SELECT 1 FROM active_config_pointers
                         WHERE scope = ? AND workspace_id = ? AND active_version_id = ?)`,
      )
      .bind(
        newVersionId,
        proposal.scope,
        proposal.workspace_id,
        nextVersionNumber,
        JSON.stringify(mergedParams),
        proposal.id,
        args.actorId,
        timestamp,
        proposal.id,
        proposal.scope,
        pointerKey,
        activePointer.active_version_id,
      ),
    db
      .prepare(
        `UPDATE active_config_pointers
            SET active_version_id = ?, updated_at = ?
          WHERE scope = ? AND workspace_id = ? AND active_version_id = ? AND ${gate}`,
      )
      .bind(newVersionId, timestamp, proposal.scope, pointerKey, activePointer.active_version_id, newVersionId),
    db
      .prepare(
        `UPDATE change_proposals
            SET status = 'applied', approved_by = ?, approved_at = ?, updated_at = ?
          WHERE id = ? AND ${gate}`,
      )
      .bind(args.actorId, timestamp, timestamp, proposal.id, newVersionId),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         SELECT ?, ?, ?, 'config.applied', 'config_version', ?, ?, ?
          WHERE ${gate}`,
      )
      .bind(
        id('ae'),
        proposal.workspace_id,
        args.actorId,
        newVersionId,
        JSON.stringify({
          proposal_id: proposal.id,
          version_number: nextVersionNumber,
          base_version_id: activePointer.active_version_id,
          evidence_ids: JSON.parse(proposal.evidence_ids_json) as unknown,
          rationale: proposal.rationale,
        }),
        timestamp,
        newVersionId,
      ),
  ]);

  if (changesAt(results, 0) === 0) {
    const now = await db
      .prepare(`SELECT status FROM change_proposals WHERE id = ?`)
      .bind(proposal.id)
      .first<{ status: string }>();
    if (now?.status === 'applied') {
      return refused('Đề xuất này đã được áp dụng trước đó.', 409, 'invalid_state');
    }
    return refused(
      'Xung đột phiên bản: Cấu hình cơ sở đã bị thay đổi bởi người khác. Vui lòng cập nhật lại đề xuất.',
      409,
      'conflict',
    );
  }

  const newVersion: ConfigVersionRow & { parameters: BusinessModelParameters } = {
    id: newVersionId,
    scope: proposal.scope,
    workspace_id: proposal.workspace_id,
    version_number: nextVersionNumber,
    parameters_json: JSON.stringify(mergedParams),
    proposal_id: proposal.id,
    created_by: args.actorId,
    created_at: timestamp,
    restored_from_version_id: null,
    parameters: mergedParams,
  };

  const updatedProposal: ChangeProposalRow = {
    ...proposal,
    status: 'applied',
    approved_by: args.actorId,
    approved_at: timestamp,
    updated_at: timestamp,
  };

  return ok({ proposal: updatedProposal, newVersion, version: newVersion });
}

/**
 * Rollback creates a new version copied from an older one of the same scope
 * and workspace, and records which — `restored_from_version_id` on the row,
 * `rolled_back_from` on the audit event. Nothing is deleted or rewritten; the
 * version being left stays in the history exactly as it was.
 */
export async function rollbackConfig(
  db: D1Like,
  args: {
    scope: ConfigScope;
    workspaceId?: string | null;
    targetVersionId: string;
    actorId: string;
  },
): Promise<Result<ConfigVersionRow & { parameters: BusinessModelParameters }>> {
  const wsId = args.scope === 'business_model' ? null : (args.workspaceId ?? null);
  const targetVersion = await db
    .prepare(
      `SELECT * FROM config_versions
        WHERE id = ? AND scope = ?
          AND (workspace_id = ? OR (workspace_id IS NULL AND ? IS NULL))`,
    )
    .bind(args.targetVersionId, args.scope, wsId, wsId)
    .first<ConfigVersionRow>();

  if (targetVersion === null) {
    return refused('Không tìm thấy phiên bản mục tiêu để khôi phục.', 404, 'not_found');
  }

  const pointerKey = pointerKeyFor(args.scope, wsId);
  const activePointer = await db
    .prepare(`SELECT active_version_id FROM active_config_pointers WHERE scope = ? AND workspace_id = ?`)
    .bind(args.scope, pointerKey)
    .first<{ active_version_id: string }>();

  if (activePointer === null) {
    return refused('Không có cấu hình đang hoạt động để khôi phục.', 400, 'validation');
  }
  if (activePointer.active_version_id === args.targetVersionId) {
    return refused('Phiên bản này đang là phiên bản hoạt động hiện tại.', 409, 'invalid_state');
  }

  const latest = await db
    .prepare(
      `SELECT version_number FROM config_versions
        WHERE scope = ? AND (workspace_id = ? OR (workspace_id IS NULL AND ? IS NULL))
        ORDER BY version_number DESC LIMIT 1`,
    )
    .bind(args.scope, wsId, wsId)
    .first<{ version_number: number }>();

  const nextVersionNumber = (latest?.version_number ?? 0) + 1;
  const newVersionId = id('cv');
  const timestamp = nowIso();
  const gate = `EXISTS (SELECT 1 FROM config_versions WHERE id = ?)`;

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO config_versions
           (id, scope, workspace_id, version_number, parameters_json, proposal_id,
            created_by, created_at, restored_from_version_id)
         SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM active_config_pointers
                         WHERE scope = ? AND workspace_id = ? AND active_version_id = ?)`,
      )
      .bind(
        newVersionId,
        args.scope,
        wsId,
        nextVersionNumber,
        targetVersion.parameters_json,
        args.actorId,
        timestamp,
        targetVersion.id,
        args.scope,
        pointerKey,
        activePointer.active_version_id,
      ),
    db
      .prepare(
        `UPDATE active_config_pointers
            SET active_version_id = ?, updated_at = ?
          WHERE scope = ? AND workspace_id = ? AND active_version_id = ? AND ${gate}`,
      )
      .bind(newVersionId, timestamp, args.scope, pointerKey, activePointer.active_version_id, newVersionId),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         SELECT ?, ?, ?, 'config.rollback', 'config_version', ?, ?, ?
          WHERE ${gate}`,
      )
      .bind(
        id('ae'),
        wsId,
        args.actorId,
        newVersionId,
        JSON.stringify({
          rolled_back_from: targetVersion.id,
          target_version_number: targetVersion.version_number,
          left_version_id: activePointer.active_version_id,
          version_number: nextVersionNumber,
        }),
        timestamp,
        newVersionId,
      ),
  ]);

  if (changesAt(results, 0) === 0) {
    return refused(
      'Cấu hình đang hoạt động vừa thay đổi bởi thao tác khác. Vui lòng tải lại rồi khôi phục lại.',
      409,
      'conflict',
    );
  }

  const targetParams = JSON.parse(targetVersion.parameters_json) as BusinessModelParameters;
  return ok({
    id: newVersionId,
    scope: args.scope,
    workspace_id: wsId,
    version_number: nextVersionNumber,
    parameters_json: targetVersion.parameters_json,
    proposal_id: null,
    created_by: args.actorId,
    created_at: timestamp,
    restored_from_version_id: targetVersion.id,
    parameters: targetParams,
  });
}

/* -------------------------------------------------------------------------- */
/* 3. OPC Commercial Ledger & Financial Invariants                            */
/* -------------------------------------------------------------------------- */

/**
 * What an obligation still has to collect: its amount, less receipts
 * confirmed against it, less pilot credits applied to it. This is the one
 * definition of "remaining", used both as a SQL fragment inside write gates
 * (so a race cannot over-allocate) and as a read for explanations.
 *
 * The fragment takes the obligation id three times as positional parameters.
 */
const OBLIGATION_REMAINING_SQL = `(
  (SELECT amount_vnd FROM opc_obligations WHERE id = ?)
  - (SELECT COALESCE(SUM(amount_vnd), 0) FROM opc_receipts WHERE obligation_id = ? AND status = 'confirmed')
  - (SELECT COALESCE(SUM(credit_amount_vnd), 0) FROM pilot_credits WHERE applied_to_obligation_id = ?)
)`;

async function obligationRemaining(db: D1Like, obligationId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT ${OBLIGATION_REMAINING_SQL} AS remaining`)
    .bind(obligationId, obligationId, obligationId)
    .first<{ remaining: number | null }>();
  return row?.remaining ?? 0;
}

/**
 * The status an obligation takes once its remaining amount is recomputed from
 * the ledger. `settled` only when nothing is left; a cancelled obligation is
 * never revived by this.
 */
function obligationStatusUpdate(db: D1Like, obligationId: string, timestamp: string, gateSql: string, gateParams: unknown[]) {
  return db
    .prepare(
      `UPDATE opc_obligations
          SET status = CASE WHEN ${OBLIGATION_REMAINING_SQL} <= 0 THEN 'settled' ELSE 'partially_settled' END,
              updated_at = ?
        WHERE id = ? AND status <> 'cancelled' AND ${gateSql}`,
    )
    .bind(obligationId, obligationId, obligationId, timestamp, obligationId, ...gateParams);
}

export async function createOpcAgreement(
  db: D1Like,
  args: {
    workspaceId: string;
    monthlyFeeVnd: number;
    setupFeeVnd: number;
    effectiveDate: string;
    pricePlaneSnapshot: Record<string, unknown>;
    actorId: string;
  },
): Promise<Result<OpcAgreementRow>> {
  assertSafeVnd(args.monthlyFeeVnd);
  assertSafeVnd(args.setupFeeVnd);

  const existing = await db
    .prepare(`SELECT id FROM opc_agreements WHERE workspace_id = ?`)
    .bind(args.workspaceId)
    .first<{ id: string }>();

  if (existing !== null) {
    return refused('Workspace này đã có hợp đồng OPC.', 409, 'invalid_state');
  }

  const agreementId = id('ag');
  const timestamp = nowIso();

  // `workspace_id` is UNIQUE on the table, so two founders creating the same
  // nursery's agreement at once cannot both succeed: the second batch raises
  // the constraint and is rolled back whole, audit row included.
  await db.batch([
    db
      .prepare(
        `INSERT INTO opc_agreements
           (id, workspace_id, status, monthly_fee_vnd, setup_fee_vnd, effective_date,
            termination_date, price_plane_snapshot_json, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .bind(
        agreementId,
        args.workspaceId,
        args.monthlyFeeVnd,
        args.setupFeeVnd,
        args.effectiveDate,
        JSON.stringify(args.pricePlaneSnapshot),
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, ?, 'opc.agreement.created', 'opc_agreement', ?, ?, ?)`,
      )
      .bind(
        id('ae'),
        args.workspaceId,
        args.actorId,
        agreementId,
        JSON.stringify({
          monthly_fee_vnd: args.monthlyFeeVnd,
          setup_fee_vnd: args.setupFeeVnd,
          effective_date: args.effectiveDate,
        }),
        timestamp,
      ),
  ]);

  const created = await db
    .prepare(`SELECT * FROM opc_agreements WHERE id = ?`)
    .bind(agreementId)
    .first<OpcAgreementRow>();

  if (created === null) return refused('Không đọc lại được hợp đồng vừa tạo.', 500, 'unavailable');
  return ok(created);
}

export async function recordOpcObligation(
  db: D1Like,
  args: {
    agreementId: string;
    workspaceId: string;
    obligationKind: OpcObligationKind;
    amountVnd: number;
    dueDate: string;
    actorId: string;
  },
): Promise<Result<OpcObligationRow>> {
  assertSafeVnd(args.amountVnd);
  if (args.amountVnd <= 0) return refused('Số tiền nghĩa vụ phải lớn hơn 0.', 400, 'validation');

  const agreement = await db
    .prepare(`SELECT id, status FROM opc_agreements WHERE id = ? AND workspace_id = ?`)
    .bind(args.agreementId, args.workspaceId)
    .first<{ id: string; status: string }>();

  if (agreement === null) return refused('Không tìm thấy hợp đồng OPC tương ứng.', 404, 'not_found');
  if (agreement.status !== 'active') {
    return refused('Hợp đồng OPC này không còn hiệu lực để ghi nhận nghĩa vụ mới.', 409, 'invalid_state');
  }

  const obligationId = id('ob');
  const timestamp = nowIso();

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO opc_obligations
           (id, agreement_id, workspace_id, obligation_kind, amount_vnd, due_date,
            status, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
          WHERE EXISTS (SELECT 1 FROM opc_agreements
                         WHERE id = ? AND workspace_id = ? AND status = 'active')`,
      )
      .bind(
        obligationId,
        args.agreementId,
        args.workspaceId,
        args.obligationKind,
        args.amountVnd,
        args.dueDate,
        timestamp,
        timestamp,
        args.agreementId,
        args.workspaceId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         SELECT ?, ?, ?, 'opc.obligation.recorded', 'opc_obligation', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM opc_obligations WHERE id = ?)`,
      )
      .bind(
        id('ae'),
        args.workspaceId,
        args.actorId,
        obligationId,
        JSON.stringify({
          agreement_id: args.agreementId,
          obligation_kind: args.obligationKind,
          amount_vnd: args.amountVnd,
          due_date: args.dueDate,
        }),
        timestamp,
        obligationId,
      ),
  ]);

  if (changesAt(results, 0) === 0) {
    return refused('Hợp đồng OPC này không còn hiệu lực để ghi nhận nghĩa vụ mới.', 409, 'invalid_state');
  }

  const created = await db
    .prepare(`SELECT * FROM opc_obligations WHERE id = ?`)
    .bind(obligationId)
    .first<OpcObligationRow>();

  if (created === null) return refused('Không đọc lại được nghĩa vụ vừa ghi nhận.', 500, 'unavailable');
  return ok(created);
}

/**
 * Confirms an OPC receipt — money the founder states has arrived from the
 * nursery — as one transaction:
 * - the receipt row is statement 0 and the gate; it is written only while the
 *   agreement is active and, when allocated to an obligation, only while that
 *   obligation still has at least this much left to collect;
 * - a `pilot_fee` receipt creates its single-use pilot credit;
 * - the obligation's status is recomputed from the ledger, not from this one
 *   receipt, so two partial payments settle it exactly once it is covered;
 * - an audit event names who confirmed it.
 * A client-supplied `receiptId` is honoured as the row id but never reused:
 * an id that already exists is a conflict, not a replay.
 */
export async function confirmOpcReceipt(
  db: D1Like,
  args: {
    receiptId: string;
    agreementId: string;
    workspaceId: string;
    obligationId?: string | null;
    amountVnd: number;
    feeType: OpcFeeType;
    reference: string;
    confirmedBy: string;
    note?: string | null;
  },
): Promise<Result<{ receipt: OpcReceiptRow; pilotCredit?: PilotCreditRow }>> {
  assertSafeVnd(args.amountVnd);
  if (args.amountVnd <= 0) return refused('Số tiền thu phải lớn hơn 0.', 400, 'validation');

  const agreement = await db
    .prepare(`SELECT id, status FROM opc_agreements WHERE id = ? AND workspace_id = ?`)
    .bind(args.agreementId, args.workspaceId)
    .first<{ id: string; status: string }>();

  if (agreement === null) return refused('Không tìm thấy hợp đồng OPC.', 404, 'not_found');
  if (agreement.status !== 'active') {
    return refused('Hợp đồng OPC này không còn hiệu lực để ghi nhận phiếu thu.', 409, 'invalid_state');
  }

  const obligationId = args.obligationId ?? null;
  if (obligationId !== null) {
    const obligation = await db
      .prepare(`SELECT * FROM opc_obligations WHERE id = ? AND workspace_id = ? AND agreement_id = ?`)
      .bind(obligationId, args.workspaceId, args.agreementId)
      .first<OpcObligationRow>();
    if (obligation === null) {
      return refused('Không tìm thấy nghĩa vụ thuộc hợp đồng này để ghi nhận phiếu thu.', 404, 'not_found');
    }
    if (obligation.status === 'cancelled') {
      return refused('Nghĩa vụ này đã bị hủy, không ghi nhận phiếu thu vào đó.', 409, 'invalid_state');
    }
    const remaining = await obligationRemaining(db, obligationId);
    if (args.amountVnd > remaining) {
      return refused(
        `Số tiền thu vượt phần còn phải thu của nghĩa vụ (còn ${remaining.toLocaleString('vi-VN')} đ).`,
        409,
        'invalid_state',
      );
    }
  }

  const receiptId = args.receiptId || id('opcrc');
  if (args.receiptId) {
    const taken = await db
      .prepare(`SELECT id FROM opc_receipts WHERE id = ?`)
      .bind(receiptId)
      .first<{ id: string }>();
    if (taken !== null) {
      return refused('Mã phiếu thu này đã tồn tại.', 409, 'conflict');
    }
  }

  const timestamp = nowIso();
  const gate = `EXISTS (SELECT 1 FROM opc_receipts WHERE id = ?)`;

  const condition =
    obligationId === null
      ? `EXISTS (SELECT 1 FROM opc_agreements WHERE id = ? AND workspace_id = ? AND status = 'active')`
      : `EXISTS (SELECT 1 FROM opc_agreements WHERE id = ? AND workspace_id = ? AND status = 'active')
         AND EXISTS (SELECT 1 FROM opc_obligations
                      WHERE id = ? AND workspace_id = ? AND agreement_id = ? AND status <> 'cancelled')
         AND ${OBLIGATION_REMAINING_SQL} >= ?`;
  const conditionParams: unknown[] =
    obligationId === null
      ? [args.agreementId, args.workspaceId]
      : [
          args.agreementId,
          args.workspaceId,
          obligationId,
          args.workspaceId,
          args.agreementId,
          obligationId,
          obligationId,
          obligationId,
          args.amountVnd,
        ];

  const statements = [
    db
      .prepare(
        `INSERT INTO opc_receipts
           (id, agreement_id, workspace_id, obligation_id, amount_vnd, fee_type,
            reference, status, confirmed_by, confirmed_at, note, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?
          WHERE ${condition}`,
      )
      .bind(
        receiptId,
        args.agreementId,
        args.workspaceId,
        obligationId,
        args.amountVnd,
        args.feeType,
        args.reference,
        args.confirmedBy,
        timestamp,
        args.note ?? null,
        timestamp,
        timestamp,
        ...conditionParams,
      ),
  ];

  let pilotCreditRow: PilotCreditRow | undefined;
  if (args.feeType === 'pilot_fee') {
    const creditId = id('pc');
    pilotCreditRow = {
      id: creditId,
      workspace_id: args.workspaceId,
      pilot_receipt_id: receiptId,
      credit_amount_vnd: args.amountVnd,
      applied_to_obligation_id: null,
      applied_at: null,
      created_at: timestamp,
    };
    statements.push(
      db
        .prepare(
          `INSERT INTO pilot_credits
             (id, workspace_id, pilot_receipt_id, credit_amount_vnd, applied_to_obligation_id,
              applied_at, created_at)
           SELECT ?, ?, ?, ?, NULL, NULL, ?
            WHERE ${gate}`,
        )
        .bind(creditId, args.workspaceId, receiptId, args.amountVnd, timestamp, receiptId),
    );
  }

  if (obligationId !== null) {
    statements.push(obligationStatusUpdate(db, obligationId, timestamp, gate, [receiptId]));
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         SELECT ?, ?, ?, 'opc.receipt.confirmed', 'opc_receipt', ?, ?, ?
          WHERE ${gate}`,
      )
      .bind(
        id('ae'),
        args.workspaceId,
        args.confirmedBy,
        receiptId,
        JSON.stringify({
          agreement_id: args.agreementId,
          obligation_id: obligationId,
          amount_vnd: args.amountVnd,
          fee_type: args.feeType,
          reference: args.reference,
          pilot_credit_id: pilotCreditRow?.id ?? null,
        }),
        timestamp,
        receiptId,
      ),
  );

  const results = await db.batch(statements);

  if (changesAt(results, 0) === 0) {
    if (obligationId !== null) {
      const remaining = await obligationRemaining(db, obligationId);
      if (args.amountVnd > remaining) {
        return refused(
          `Số tiền thu vượt phần còn phải thu của nghĩa vụ (còn ${Math.max(0, remaining).toLocaleString('vi-VN')} đ).`,
          409,
          'invalid_state',
        );
      }
    }
    return refused(GENERIC_CONFLICT_MESSAGE, 409, 'conflict');
  }

  const saved = await db
    .prepare(`SELECT * FROM opc_receipts WHERE id = ?`)
    .bind(receiptId)
    .first<OpcReceiptRow>();

  if (saved === null) return refused('Không đọc lại được phiếu thu OPC.', 500, 'unavailable');
  return ok({ receipt: saved, pilotCredit: pilotCreditRow });
}

/**
 * Applies a single-use pilot credit to an obligation, as one transaction.
 *
 * Statement 0 is the audit event and the gate: it is written only while the
 * credit is unapplied, the obligation is open, and the credit does not exceed
 * what the obligation still has to collect. The credit and the obligation
 * change only where that audit row exists. A credit larger than the remaining
 * amount is refused rather than partly consumed — the ledger has no rule for
 * carrying a remainder, and none is invented here.
 */
export async function applyPilotCredit(
  db: D1Like,
  args: {
    creditId: string;
    obligationId: string;
    workspaceId: string;
    actorId: string;
  },
): Promise<Result<{ credit: PilotCreditRow; obligation: OpcObligationRow }>> {
  const credit = await db
    .prepare(`SELECT * FROM pilot_credits WHERE id = ? AND workspace_id = ?`)
    .bind(args.creditId, args.workspaceId)
    .first<PilotCreditRow>();

  if (credit === null) {
    return refused('Không tìm thấy khoản tín dụng thí điểm (pilot credit).', 404, 'not_found');
  }
  if (credit.applied_to_obligation_id !== null) {
    return refused(
      'Khoản tín dụng thí điểm này đã được áp dụng trước đó (chỉ dùng 1 lần).',
      409,
      'invalid_state',
    );
  }

  const obligation = await db
    .prepare(`SELECT * FROM opc_obligations WHERE id = ? AND workspace_id = ?`)
    .bind(args.obligationId, args.workspaceId)
    .first<OpcObligationRow>();

  if (obligation === null) {
    return refused('Không tìm thấy nghĩa vụ cần áp dụng tín dụng.', 404, 'not_found');
  }
  if (obligation.status === 'settled' || obligation.status === 'cancelled') {
    return refused('Nghĩa vụ này đã hoàn tất hoặc đã hủy, không áp dụng tín dụng được.', 409, 'invalid_state');
  }
  const remainingBefore = await obligationRemaining(db, args.obligationId);
  if (credit.credit_amount_vnd > remainingBefore) {
    return refused(
      `Tín dụng thí điểm (${credit.credit_amount_vnd.toLocaleString('vi-VN')} đ) lớn hơn phần còn phải thu (${Math.max(0, remainingBefore).toLocaleString('vi-VN')} đ); chưa có quy tắc dùng một phần tín dụng.`,
      409,
      'invalid_state',
    );
  }

  const auditId = id('ae');
  const timestamp = nowIso();
  const gate = `EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`;

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         SELECT ?, ?, ?, 'opc.pilot_credit.applied', 'pilot_credit', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM pilot_credits
                         WHERE id = ? AND workspace_id = ? AND applied_to_obligation_id IS NULL)
            AND EXISTS (SELECT 1 FROM opc_obligations
                         WHERE id = ? AND workspace_id = ? AND status IN ('pending', 'partially_settled'))
            AND ${OBLIGATION_REMAINING_SQL} >= ?`,
      )
      .bind(
        auditId,
        args.workspaceId,
        args.actorId,
        args.creditId,
        JSON.stringify({
          obligation_id: args.obligationId,
          credit_amount_vnd: credit.credit_amount_vnd,
          pilot_receipt_id: credit.pilot_receipt_id,
        }),
        timestamp,
        args.creditId,
        args.workspaceId,
        args.obligationId,
        args.workspaceId,
        args.obligationId,
        args.obligationId,
        args.obligationId,
        credit.credit_amount_vnd,
      ),
    db
      .prepare(
        `UPDATE pilot_credits
            SET applied_to_obligation_id = ?, applied_at = ?
          WHERE id = ? AND applied_to_obligation_id IS NULL AND ${gate}`,
      )
      .bind(args.obligationId, timestamp, args.creditId, auditId),
    obligationStatusUpdate(db, args.obligationId, timestamp, gate, [auditId]),
  ]);

  if (changesAt(results, 0) === 0) {
    const creditNow = await db
      .prepare(`SELECT applied_to_obligation_id FROM pilot_credits WHERE id = ?`)
      .bind(args.creditId)
      .first<{ applied_to_obligation_id: string | null }>();
    if (creditNow?.applied_to_obligation_id !== null && creditNow?.applied_to_obligation_id !== undefined) {
      return refused('Khoản tín dụng thí điểm này đã bị sử dụng trong thao tác khác.', 409, 'invalid_state');
    }
    return refused(GENERIC_CONFLICT_MESSAGE, 409, 'conflict');
  }

  const updatedCredit = await db
    .prepare(`SELECT * FROM pilot_credits WHERE id = ?`)
    .bind(args.creditId)
    .first<PilotCreditRow>();
  const updatedObligation = await db
    .prepare(`SELECT * FROM opc_obligations WHERE id = ?`)
    .bind(args.obligationId)
    .first<OpcObligationRow>();

  if (updatedCredit === null || updatedObligation === null) {
    return refused('Không đọc lại được trạng thái sau khi khấu trừ tín dụng.', 500, 'unavailable');
  }

  return ok({ credit: updatedCredit, obligation: updatedObligation });
}

/**
 * Computes the 3 distinct financial metrics (§13):
 * 1. Active MRR (Monthly Recurring Revenue): Active subscriptions only. Prepaid 12-month / 12. Setup/pilot fees EXCLUDED.
 * 2. Total Cash Collected in period: Confirmed non-reversed OPC receipts.
 * 3. Outstanding Receivables: Sum of unpaid obligations minus applied credits. Never conflated with MRR!
 */
/**
 * A workspace scope for the OPC ledger: one id, a list of ids, or nothing.
 *
 * A founder reads the ledger for the workspaces they administer — the list the
 * chokepoint resolved — and may narrow it to one. `undefined` means no
 * restriction and is kept for direct callers (tests, scripts); the route never
 * passes it.
 */
export type OpcScope = string | readonly string[] | undefined;

function scopeClause(scope: OpcScope, column = 'workspace_id'): { sql: string; params: string[] } {
  if (scope === undefined) return { sql: '', params: [] };
  const ids = typeof scope === 'string' ? [scope] : [...scope];
  if (ids.length === 0) return { sql: ' AND 0', params: [] };
  return { sql: ` AND ${column} IN (${ids.map(() => '?').join(', ')})`, params: ids };
}

export async function computeOpcFinancialMetrics(
  db: D1Like,
  scope?: OpcScope,
): Promise<{
  active_mrr_vnd: number;
  cash_collected_vnd: number;
  outstanding_receivables_vnd: number;
}> {
  const where = scopeClause(scope);

  // 1. Active MRR: the monthly fee of active agreements. Setup and pilot fees
  //    are one-off and never counted here.
  const mrrResult = await db
    .prepare(
      `SELECT COALESCE(SUM(monthly_fee_vnd), 0) AS mrr FROM opc_agreements WHERE status = 'active'${where.sql}`,
    )
    .bind(...where.params)
    .first<{ mrr: number }>();
  const activeMrr = assertSafeVnd(mrrResult?.mrr ?? 0);

  // 2. Cash collected: confirmed receipts only. A recorded obligation is not
  //    cash, and neither is a pilot credit.
  const cashResult = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_vnd), 0) AS total FROM opc_receipts WHERE status = 'confirmed'${where.sql}`,
    )
    .bind(...where.params)
    .first<{ total: number }>();
  const cashCollected = assertSafeVnd(cashResult?.total ?? 0);

  // 3. Outstanding receivables: open obligations net of confirmed receipts and
  //    applied credits — the same "remaining" the write gates use. An
  //    obligation covered beyond its amount by older rows contributes zero,
  //    never a negative that would hide another's balance.
  const { results: remainingRows } = await db
    .prepare(
      `SELECT o.id AS id,
              o.amount_vnd
                - (SELECT COALESCE(SUM(r.amount_vnd), 0) FROM opc_receipts r
                    WHERE r.obligation_id = o.id AND r.status = 'confirmed')
                - (SELECT COALESCE(SUM(c.credit_amount_vnd), 0) FROM pilot_credits c
                    WHERE c.applied_to_obligation_id = o.id) AS remaining
         FROM opc_obligations o
        WHERE o.status IN ('pending', 'partially_settled')${scopeClause(scope, 'o.workspace_id').sql}`,
    )
    .bind(...where.params)
    .all<{ id: string; remaining: number }>();

  let totalOutstanding = 0;
  for (const row of remainingRows) {
    totalOutstanding = addVnd(totalOutstanding, Math.max(0, assertSafeVnd(row.remaining)));
  }

  return {
    active_mrr_vnd: activeMrr,
    cash_collected_vnd: cashCollected,
    outstanding_receivables_vnd: totalOutstanding,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Economics Engine Integration (§13, §15 case 14)                         */
/* -------------------------------------------------------------------------- */

export interface EnrichedScenarioResult extends ScenarioResult {
  activeCustomers: number;
  newSetupsInMonth: number;
  operatingProfitVnd: number;
  founderHoursUsed: number;
}

function enrichScenario(s: ScenarioResult): EnrichedScenarioResult {
  return {
    ...s,
    activeCustomers: s.customers,
    newSetupsInMonth: s.new_setups,
    operatingProfitVnd: s.cash_surplus_vnd,
    founderHoursUsed: s.hours,
  };
}

/**
 * Where a scenario's parameters came from. A scenario is a simulation of the
 * parameters it was given; this names them so no reader mistakes seed
 * defaults for a measured business.
 */
export type ParametersSource =
  | { kind: 'config_version'; version_id: string; version_number: number; created_at: string }
  | { kind: 'baseline_default'; note: string };

export async function runEconomicsScenarios(
  db: D1Like,
): Promise<{
  parameters: BusinessModelParameters;
  parameters_source: ParametersSource;
  scenarios: EnrichedScenarioResult[];
}> {
  const active = await getActiveConfig(db, 'business_model');
  let params: BusinessModelParameters;
  let source: ParametersSource;

  if (active !== null) {
    params = active.parameters;
    source = {
      kind: 'config_version',
      version_id: active.version.id,
      version_number: active.version.version_number,
      created_at: active.version.created_at,
    };
  } else {
    source = {
      kind: 'baseline_default',
      note: 'Tham số mặc định trong mã nguồn (§10) — chưa có phiên bản cấu hình nào được công bố; chưa được kiểm chứng thị trường.',
    };
    // Default baseline parameters from §10
    params = {
      pilot_fee_vnd: 3000000,
      setup_fee_vnd: 10000000,
      monthly_fee_vnd: 3000000,
      direct_cost_per_customer_month_vnd: 350000,
      direct_cost_per_setup_vnd: 500000,
      fixed_cost_per_month_vnd: 2500000,
      founder_hourly_value_vnd: 150000,
      support_hours_per_customer_month: 4,
      setup_hours_per_customer: 24,
      sales_hours_per_month: 24,
      maintenance_hours_per_month: 16,
      admin_hours_per_month: 16,
      buffer_hours_per_month: 16,
      capacity_hours_per_month: 160,
      minimum_benefit_cost_ratio: 3,
    };
  }

  return {
    parameters: params,
    parameters_source: source,
    scenarios: [
      enrichScenario(computeScenario(params, 5, 0)),
      enrichScenario(computeScenario(params, 10, 0)),
      enrichScenario(computeScenario(params, 10, 2)),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* 5. CSV Export with Formula Escaping (§10)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Escapes formula characters (=, +, -, @) to prevent CSV injection when opened in spreadsheets.
 */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'''${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportInterviewsToCsv(
  interviews: FounderInterviewRow[],
  observations: FounderObservationRow[],
): string {
  const headers = [
    'external_id',
    'organization_alias',
    'respondent_role',
    'interviewed_at',
    'data_origin',
    'notes',
    'metric_key',
    'value_num',
    'value_str',
    'unit',
    'period',
    'evidence_kind',
    'source_ref',
  ];

  const lines = [headers.join(',')];

  for (const obs of observations) {
    const interview = interviews.find((i) => i.id === obs.interview_id);
    if (!interview) continue;
    const row = [
      escapeCsvField(interview.external_id),
      escapeCsvField(interview.organization_alias),
      escapeCsvField(interview.respondent_role),
      escapeCsvField(interview.interviewed_at),
      escapeCsvField(interview.data_origin),
      escapeCsvField(interview.notes),
      escapeCsvField(obs.metric_key),
      escapeCsvField(obs.value_num),
      escapeCsvField(obs.value_str),
      escapeCsvField(obs.unit),
      escapeCsvField(obs.period),
      escapeCsvField(obs.evidence_kind),
      escapeCsvField(obs.source_ref),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

export async function listConfigVersions(
  db: D1Like,
  scope: ConfigScope,
  workspaceId: string | null = null,
): Promise<ConfigVersionRow[]> {
  if (scope === 'business_model') {
    const { results } = await db
      .prepare(`SELECT * FROM config_versions WHERE scope = 'business_model' ORDER BY version_number DESC`)
      .all<ConfigVersionRow>();
    return results;
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM config_versions WHERE scope = 'workspace_operations' AND workspace_id = ? ORDER BY version_number DESC`,
    )
    .bind(workspaceId)
    .all<ConfigVersionRow>();
  return results;
}

export async function listChangeProposals(
  db: D1Like,
  scope?: ConfigScope,
  workspaceId?: string | null,
): Promise<ChangeProposalRow[]> {
  if (scope === 'business_model') {
    const { results } = await db
      .prepare(`SELECT * FROM change_proposals WHERE scope = 'business_model' ORDER BY created_at DESC`)
      .all<ChangeProposalRow>();
    return results;
  }
  if (scope === 'workspace_operations' && workspaceId) {
    const { results } = await db
      .prepare(
        `SELECT * FROM change_proposals WHERE scope = 'workspace_operations' AND workspace_id = ? ORDER BY created_at DESC`,
      )
      .bind(workspaceId)
      .all<ChangeProposalRow>();
    return results;
  }
  const { results } = await db
    .prepare(`SELECT * FROM change_proposals ORDER BY created_at DESC`)
    .all<ChangeProposalRow>();
  return results;
}

export async function listOpcLedger(
  db: D1Like,
  scope?: OpcScope,
): Promise<{
  agreements: OpcAgreementRow[];
  obligations: OpcObligationRow[];
  receipts: OpcReceiptRow[];
  pilotCredits: PilotCreditRow[];
  metrics: {
    active_mrr_vnd: number;
    cash_collected_vnd: number;
    outstanding_receivables_vnd: number;
  };
}> {
  const where = scopeClause(scope);
  const read = async <T>(table: string, order: string): Promise<T[]> =>
    (
      await db
        .prepare(`SELECT * FROM ${table} WHERE 1${where.sql} ORDER BY ${order}`)
        .bind(...where.params)
        .all<T>()
    ).results;

  const agreements = await read<OpcAgreementRow>('opc_agreements', 'created_at DESC');
  const obligations = await read<OpcObligationRow>('opc_obligations', 'due_date ASC');
  const receipts = await read<OpcReceiptRow>('opc_receipts', 'created_at DESC');
  const pilotCredits = await read<PilotCreditRow>('pilot_credits', 'created_at DESC');
  const metrics = await computeOpcFinancialMetrics(db, scope);

  return { agreements, obligations, receipts, pilotCredits, metrics };
}

export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_IMPORT_OBSERVATIONS = 500;

export interface ImportInterviewItem {
  external_id: string;
  organization_alias: string;
  respondent_role: string;
  interviewed_at: string;
  data_origin: 'synthetic' | 'real';
  notes?: string | null;
  observations: ObservationInput[];
}

export function validateImportBatch(
  items: ImportInterviewItem[],
  byteLength: number,
  envAppEnv?: string,
): Result<{ interviewsCount: number; observationsCount: number; items: ImportInterviewItem[] }> {
  if (byteLength > MAX_IMPORT_BYTES) {
    return refused(`Dung lượng tệp nhập vượt quá giới hạn 256 KiB (${byteLength} bytes).`, 400, 'validation');
  }

  const seen = new Set<string>();
  let totalObs = 0;
  for (const item of items) {
    if (seen.has(item.external_id)) {
      return refused(
        `Mã phỏng vấn "${item.external_id}" xuất hiện nhiều lần trong cùng một lần nhập.`,
        400,
        'validation',
      );
    }
    seen.add(item.external_id);
    if (envAppEnv === 'pilot' && item.data_origin === 'synthetic') {
      return refused(
        `Phỏng vấn "${item.external_id}" là dữ liệu mẫu (synthetic) — chỉ được phép ở môi trường dev/demo, bị từ chối trên môi trường Pilot thực tế.`,
        400,
        'validation',
      );
    }
    totalObs += item.observations.length;
    if (totalObs > MAX_IMPORT_OBSERVATIONS) {
      return refused(`Tổng số quan sát vượt quá ${MAX_IMPORT_OBSERVATIONS} dòng mỗi lần nhập.`, 400, 'validation');
    }
    for (const obs of item.observations) {
      if (!ALLOWED_METRIC_KEYS.includes(obs.metric_key)) {
        return refused(
          `Phỏng vấn "${item.external_id}" có metric_key không thuộc danh mục cho phép: "${obs.metric_key}".`,
          400,
          'validation',
        );
      }
    }
  }

  return ok({
    interviewsCount: items.length,
    observationsCount: totalObs,
    items,
  });
}

