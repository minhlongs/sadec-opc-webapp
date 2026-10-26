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
}

export interface Refusal {
  kind: 'refused';
  message: string;
  status: number;
  value?: never;
}

export type Result<T> = Outcome<T> | Refusal;

function ok<T>(value: T): Outcome<T> {
  return { kind: 'ok', value };
}

function refused(message: string, status: number): Refusal {
  return { kind: 'refused', message, status };
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
  // Pilot guard: Synthetic data is refused in pilot environment
  if (envAppEnv === 'pilot' && args.data_origin === 'synthetic') {
    return refused(
      'Dữ liệu mẫu (synthetic) chỉ được phép ở môi trường dev/demo, bị từ chối trên môi trường Pilot thực tế.',
      400,
    );
  }

  // Validate metric keys
  for (const obs of observations) {
    if (!ALLOWED_METRIC_KEYS.includes(obs.metric_key)) {
      return refused(`Khóa chỉ số không hợp lệ: "${obs.metric_key}".`, 400);
    }
  }

  const existing = await db
    .prepare(`SELECT * FROM founder_interviews WHERE external_id = ?`)
    .bind(args.external_id)
    .first<FounderInterviewRow>();

  const timestamp = nowIso();

  if (existing === null) {
    // Create new interview
    const interviewId = id('int');
    const interviewRow: FounderInterviewRow = {
      id: interviewId,
      external_id: args.external_id,
      organization_alias: args.organization_alias,
      respondent_role: args.respondent_role,
      interviewed_at: args.interviewed_at,
      data_origin: args.data_origin,
      notes: args.notes ?? null,
      recorded_by: args.actorId,
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    };

    const statements = [
      db
        .prepare(
          `INSERT INTO founder_interviews
             (id, external_id, organization_alias, respondent_role, interviewed_at,
              data_origin, notes, recorded_by, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          interviewRow.id,
          interviewRow.external_id,
          interviewRow.organization_alias,
          interviewRow.respondent_role,
          interviewRow.interviewed_at,
          interviewRow.data_origin,
          interviewRow.notes,
          interviewRow.recorded_by,
          interviewRow.revision,
          interviewRow.created_at,
          interviewRow.updated_at,
        ),
    ];

    const obsRows: FounderObservationRow[] = [];
    for (const obs of observations) {
      const obsId = id('obs');
      const isNull = obs.is_null || (obs.value_num === null && obs.value_str === null) ? 1 : 0;
      obsRows.push({
        id: obsId,
        interview_id: interviewId,
        metric_key: obs.metric_key,
        value_num: obs.value_num ?? null,
        value_str: obs.value_str ?? null,
        unit: obs.unit,
        period: obs.period ?? null,
        evidence_kind: obs.evidence_kind,
        source_ref: obs.source_ref ?? null,
        is_null: isNull,
        revision: 1,
        created_at: timestamp,
      });

      statements.push(
        db
          .prepare(
            `INSERT INTO founder_observations
               (id, interview_id, metric_key, value_num, value_str, unit, period,
                evidence_kind, source_ref, is_null, revision, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            obsId,
            interviewId,
            obs.metric_key,
            obs.value_num ?? null,
            obs.value_str ?? null,
            obs.unit,
            obs.period ?? null,
            obs.evidence_kind,
            obs.source_ref ?? null,
            isNull,
            1,
            timestamp,
          ),
      );
    }

    await db.batch(statements);
    return ok({ ...interviewRow, interview: interviewRow, observations: obsRows, wasRevision: false });
  }

  // If existing, check if data origin is changing from synthetic to real (refused)
  if (existing.data_origin === 'synthetic' && args.data_origin === 'real') {
    return refused('Không được chuyển đổi trực tiếp nguồn dữ liệu từ synthetic sang real.', 400);
  }

  // Idempotency check: if all values match existing, return existing without duplicating
  const { results: existingObs } = await db
    .prepare(`SELECT * FROM founder_observations WHERE interview_id = ? AND revision = ?`)
    .bind(existing.id, existing.revision)
    .all<FounderObservationRow>();

  const isIdentical =
    existing.organization_alias === args.organization_alias &&
    existing.respondent_role === args.respondent_role &&
    existing.interviewed_at === args.interviewed_at &&
    (existing.notes ?? null) === (args.notes ?? null) &&
    existingObs.length === observations.length &&
    observations.every((o) =>
      existingObs.some(
        (eo) =>
          eo.metric_key === o.metric_key &&
          eo.value_num === (o.value_num ?? null) &&
          eo.unit === o.unit &&
          eo.evidence_kind === o.evidence_kind,
      ),
    );

  if (isIdentical) {
    return ok({ ...existing, interview: existing, observations: existingObs, wasRevision: false });
  }

  // New revision for existing interview (append-only)
  const nextRev = existing.revision + 1;
  const updateInterview = db
    .prepare(
      `UPDATE founder_interviews
          SET organization_alias = ?, respondent_role = ?, interviewed_at = ?,
              notes = ?, revision = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      args.organization_alias,
      args.respondent_role,
      args.interviewed_at,
      args.notes ?? existing.notes,
      nextRev,
      timestamp,
      existing.id,
    );

  const statements = [updateInterview];
  const newObsRows: FounderObservationRow[] = [];

  for (const obs of observations) {
    const obsId = id('obs');
    const isNull = obs.is_null || (obs.value_num === null && obs.value_str === null) ? 1 : 0;
    newObsRows.push({
      id: obsId,
      interview_id: existing.id,
      metric_key: obs.metric_key,
      value_num: obs.value_num ?? null,
      value_str: obs.value_str ?? null,
      unit: obs.unit,
      period: obs.period ?? null,
      evidence_kind: obs.evidence_kind,
      source_ref: obs.source_ref ?? null,
      is_null: isNull,
      revision: nextRev,
      created_at: timestamp,
    });

    statements.push(
      db
        .prepare(
          `INSERT INTO founder_observations
             (id, interview_id, metric_key, value_num, value_str, unit, period,
              evidence_kind, source_ref, is_null, revision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          obsId,
          existing.id,
          obs.metric_key,
          obs.value_num ?? null,
          obs.value_str ?? null,
          obs.unit,
          obs.period ?? null,
          obs.evidence_kind,
          obs.source_ref ?? null,
          isNull,
          nextRev,
          timestamp,
        ),
    );
  }

  await db.batch(statements);
  const updatedInterview: FounderInterviewRow = {
    ...existing,
    organization_alias: args.organization_alias,
    respondent_role: args.respondent_role,
    interviewed_at: args.interviewed_at,
    notes: args.notes ?? existing.notes,
    revision: nextRev,
    updated_at: timestamp,
  };

  return ok({ ...updatedInterview, interview: updatedInterview, observations: newObsRows, wasRevision: true });
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

export async function createInitialConfigVersion(
  db: D1Like,
  scope: ConfigScope,
  workspaceId: string | null,
  parameters: BusinessModelParameters,
  actorId: string,
): Promise<ConfigVersionRow> {
  assertValidParameters(parameters);
  const versionId = id('cv');
  const timestamp = nowIso();
  const pointerKey = scope === 'business_model' ? 'global' : (workspaceId ?? 'global');

  await db.batch([
    db
      .prepare(
        `INSERT INTO config_versions
           (id, scope, workspace_id, version_number, parameters_json, proposal_id,
            created_by, created_at)
         VALUES (?, ?, ?, 1, ?, NULL, ?, ?)`,
      )
      .bind(versionId, scope, workspaceId, JSON.stringify(parameters), actorId, timestamp),
    db
      .prepare(
        `INSERT OR REPLACE INTO active_config_pointers
           (scope, workspace_id, active_version_id, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(scope, pointerKey, versionId, timestamp),
  ]);

  return {
    id: versionId,
    scope,
    workspace_id: workspaceId,
    version_number: 1,
    parameters_json: JSON.stringify(parameters),
    proposal_id: null,
    created_by: actorId,
    created_at: timestamp,
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
  const wsId = args.workspaceId ?? null;

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
      args.baseVersionId,
      JSON.stringify(args.changes),
      JSON.stringify(args.evidenceIds),
      args.rationale,
      args.proposedBy,
      timestamp,
      timestamp,
    )
    .run();

  const created = await db
    .prepare(`SELECT * FROM change_proposals WHERE id = ?`)
    .bind(proposalId)
    .first<ChangeProposalRow>();

  if (created === null) return refused('Không đọc lại được đề xuất thay đổi vừa tạo.', 500);
  return ok(created);
}

/**
 * Applies a change proposal atomically:
 * - Checks that base_version_id is still the active version (optimistic concurrency)
 * - Computes the new parameter set by merging changes into base version
 * - Validates the new parameters
 * - Inserts a new immutable ConfigVersion
 * - Moves the active_config_pointer
 * - Updates proposal status to 'applied'
 * - Records an audit row
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

  if (proposal === null) return refused('Không tìm thấy đề xuất thay đổi.', 404);
  if (proposal.status === 'applied') {
    return refused('Đề xuất này đã được áp dụng trước đó.', 409);
  }
  if (proposal.status === 'rejected') {
    return refused('Đề xuất này đã bị từ chối, không thể áp dụng.', 409);
  }

  const pointerKey = proposal.scope === 'business_model' ? 'global' : (proposal.workspace_id ?? 'global');
  const activePointer = await db
    .prepare(`SELECT active_version_id FROM active_config_pointers WHERE scope = ? AND workspace_id = ?`)
    .bind(proposal.scope, pointerKey)
    .first<{ active_version_id: string }>();

  // Optimistic concurrency check
  if (proposal.base_version_id !== null && activePointer?.active_version_id !== proposal.base_version_id) {
    return refused(
      'Xung đột phiên bản: Cấu hình cơ sở đã bị thay đổi bởi người khác. Vui lòng cập nhật lại đề xuất.',
      409,
    );
  }

  let baseParams: BusinessModelParameters;
  let nextVersionNumber = 1;

  if (activePointer !== null) {
    const activeVersion = await db
      .prepare(`SELECT * FROM config_versions WHERE id = ?`)
      .bind(activePointer.active_version_id)
      .first<ConfigVersionRow>();
    if (activeVersion === null) return refused('Không tìm thấy phiên bản cấu hình hiện tại.', 500);
    baseParams = JSON.parse(activeVersion.parameters_json);
    nextVersionNumber = activeVersion.version_number + 1;
  } else {
    return refused('Không có cấu hình khởi tạo để áp dụng thay đổi.', 400);
  }

  const changes = JSON.parse(proposal.changes_json) as Partial<BusinessModelParameters>;
  const mergedParams: BusinessModelParameters = {
    ...baseParams,
    ...changes,
  };

  try {
    assertValidParameters(mergedParams);
  } catch (err: unknown) {
    return refused(`Tham số cấu hình mới không hợp lệ: ${err instanceof Error ? err.message : String(err)}`, 400);
  }

  const newVersionId = id('cv');
  const timestamp = nowIso();

  await db.batch([
    db
      .prepare(
        `INSERT INTO config_versions
           (id, scope, workspace_id, version_number, parameters_json, proposal_id,
            created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ),
    db
      .prepare(
        `UPDATE active_config_pointers
            SET active_version_id = ?, updated_at = ?
          WHERE scope = ? AND workspace_id = ?`,
      )
      .bind(newVersionId, timestamp, proposal.scope, pointerKey),
    db
      .prepare(
        `UPDATE change_proposals
            SET status = 'applied', approved_by = ?, approved_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(args.actorId, timestamp, timestamp, proposal.id),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, ?, 'config.applied', 'config_version', ?, ?, ?)`,
      )
      .bind(
        id('ae'),
        proposal.workspace_id,
        args.actorId,
        newVersionId,
        JSON.stringify({ proposal_id: proposal.id, version_number: nextVersionNumber }),
        timestamp,
      ),
  ]);

  const newVersion: ConfigVersionRow & { parameters: BusinessModelParameters } = {
    id: newVersionId,
    scope: proposal.scope,
    workspace_id: proposal.workspace_id,
    version_number: nextVersionNumber,
    parameters_json: JSON.stringify(mergedParams),
    proposal_id: proposal.id,
    created_by: args.actorId,
    created_at: timestamp,
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

/** Rollback creates a new version copied from an older version. Deletes nothing. */
export async function rollbackConfig(
  db: D1Like,
  args: {
    scope: ConfigScope;
    workspaceId?: string | null;
    targetVersionId: string;
    actorId: string;
  },
): Promise<Result<ConfigVersionRow & { parameters: BusinessModelParameters }>> {
  const wsId = args.workspaceId ?? null;
  const targetVersion = await db
    .prepare(`SELECT * FROM config_versions WHERE id = ? AND scope = ?`)
    .bind(args.targetVersionId, args.scope)
    .first<ConfigVersionRow>();

  if (targetVersion === null) return refused('Không tìm thấy phiên bản mục tiêu để khôi phục.', 404);

  const pointerKey = args.scope === 'business_model' ? 'global' : (wsId ?? 'global');
  const activePointer = await db
    .prepare(`SELECT active_version_id FROM active_config_pointers WHERE scope = ? AND workspace_id = ?`)
    .bind(args.scope, pointerKey)
    .first<{ active_version_id: string }>();

  if (activePointer?.active_version_id === args.targetVersionId) {
    return refused('Phiên bản này đang là phiên bản hoạt động hiện tại.', 400);
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

  await db.batch([
    db
      .prepare(
        `INSERT INTO config_versions
           (id, scope, workspace_id, version_number, parameters_json, proposal_id,
            created_by, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(
        newVersionId,
        args.scope,
        wsId,
        nextVersionNumber,
        targetVersion.parameters_json,
        args.actorId,
        timestamp,
      ),
    db
      .prepare(
        `UPDATE active_config_pointers
            SET active_version_id = ?, updated_at = ?
          WHERE scope = ? AND workspace_id = ?`,
      )
      .bind(newVersionId, timestamp, args.scope, pointerKey),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, ?, 'config.rollback', 'config_version', ?, ?, ?)`,
      )
      .bind(
        id('ae'),
        wsId,
        args.actorId,
        newVersionId,
        JSON.stringify({ rolled_back_from: targetVersion.id, target_version_number: targetVersion.version_number }),
        timestamp,
      ),
  ]);

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
    parameters: targetParams,
  });
}

/* -------------------------------------------------------------------------- */
/* 3. OPC Commercial Ledger & Financial Invariants                            */
/* -------------------------------------------------------------------------- */

export async function createOpcAgreement(
  db: D1Like,
  args: {
    workspaceId: string;
    monthlyFeeVnd: number;
    setupFeeVnd: number;
    effectiveDate: string;
    pricePlaneSnapshot: Record<string, unknown>;
  },
): Promise<Result<OpcAgreementRow>> {
  assertSafeVnd(args.monthlyFeeVnd);
  assertSafeVnd(args.setupFeeVnd);

  const existing = await db
    .prepare(`SELECT id FROM opc_agreements WHERE workspace_id = ?`)
    .bind(args.workspaceId)
    .first<{ id: string }>();

  if (existing !== null) {
    return refused('Workspace này đã có hợp đồng OPC.', 409);
  }

  const agreementId = id('ag');
  const timestamp = nowIso();

  await db
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
    )
    .run();

  const created = await db
    .prepare(`SELECT * FROM opc_agreements WHERE id = ?`)
    .bind(agreementId)
    .first<OpcAgreementRow>();

  if (created === null) return refused('Không đọc lại được hợp đồng vừa tạo.', 500);
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
  },
): Promise<Result<OpcObligationRow>> {
  assertSafeVnd(args.amountVnd);
  if (args.amountVnd <= 0) return refused('Số tiền nghĩa vụ phải lớn hơn 0.', 400);

  const agreement = await db
    .prepare(`SELECT id FROM opc_agreements WHERE id = ? AND workspace_id = ?`)
    .bind(args.agreementId, args.workspaceId)
    .first<{ id: string }>();

  if (agreement === null) return refused('Không tìm thấy hợp đồng OPC tương ứng.', 404);

  const obligationId = id('ob');
  const timestamp = nowIso();

  await db
    .prepare(
      `INSERT INTO opc_obligations
         (id, agreement_id, workspace_id, obligation_kind, amount_vnd, due_date,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
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
    )
    .run();

  const created = await db
    .prepare(`SELECT * FROM opc_obligations WHERE id = ?`)
    .bind(obligationId)
    .first<OpcObligationRow>();

  if (created === null) return refused('Không đọc lại được nghĩa vụ vừa ghi nhận.', 500);
  return ok(created);
}

/**
 * Confirms an OPC receipt:
 * - If fee_type is 'pilot_fee', it creates a single-use PilotCredit record.
 * - Allocates payment to an obligation if provided.
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
  if (args.amountVnd <= 0) return refused('Số tiền thu phải lớn hơn 0.', 400);

  const agreement = await db
    .prepare(`SELECT id FROM opc_agreements WHERE id = ? AND workspace_id = ?`)
    .bind(args.agreementId, args.workspaceId)
    .first<{ id: string }>();

  if (agreement === null) return refused('Không tìm thấy hợp đồng OPC.', 404);

  const receiptId = args.receiptId || id('opcrc');
  const timestamp = nowIso();

  const statements = [
    db
      .prepare(
        `INSERT INTO opc_receipts
           (id, agreement_id, workspace_id, obligation_id, amount_vnd, fee_type,
            reference, status, confirmed_by, confirmed_at, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`,
      )
      .bind(
        receiptId,
        args.agreementId,
        args.workspaceId,
        args.obligationId ?? null,
        args.amountVnd,
        args.feeType,
        args.reference,
        args.confirmedBy,
        timestamp,
        args.note ?? null,
        timestamp,
        timestamp,
      ),
  ];

  let pilotCreditRow: PilotCreditRow | undefined;

  // Single-use pilot credit if qualifying pilot fee
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
           VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .bind(creditId, args.workspaceId, receiptId, args.amountVnd, timestamp),
    );
  }

  // Update obligation status if linked
  if (args.obligationId) {
    const obligation = await db
      .prepare(`SELECT * FROM opc_obligations WHERE id = ? AND workspace_id = ?`)
      .bind(args.obligationId, args.workspaceId)
      .first<OpcObligationRow>();

    if (obligation) {
      const nextStatus = args.amountVnd >= obligation.amount_vnd ? 'settled' : 'partially_settled';
      statements.push(
        db
          .prepare(`UPDATE opc_obligations SET status = ?, updated_at = ? WHERE id = ?`)
          .bind(nextStatus, timestamp, args.obligationId),
      );
    }
  }

  await db.batch(statements);

  const saved = await db
    .prepare(`SELECT * FROM opc_receipts WHERE id = ?`)
    .bind(receiptId)
    .first<OpcReceiptRow>();

  if (saved === null) return refused('Không đọc lại được phiếu thu OPC.', 500);
  return ok({ receipt: saved, pilotCredit: pilotCreditRow });
}

/**
 * Applies a single-use pilot credit to an obligation.
 * Re-application of an already applied credit is refused by UNIQUE constraint or status check.
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

  if (credit === null) return refused('Không tìm thấy khoản tín dụng thí điểm (pilot credit).', 404);
  if (credit.applied_to_obligation_id !== null) {
    return refused('Khoản tín dụng thí điểm này đã được áp dụng trước đó (chỉ dùng 1 lần).', 409);
  }

  const obligation = await db
    .prepare(`SELECT * FROM opc_obligations WHERE id = ? AND workspace_id = ?`)
    .bind(args.obligationId, args.workspaceId)
    .first<OpcObligationRow>();

  if (obligation === null) return refused('Không tìm thấy nghĩa vụ cần áp dụng tín dụng.', 404);
  if (obligation.status === 'settled') {
    return refused('Nghĩa vụ này đã hoàn tất thanh toán.', 409);
  }

  const timestamp = nowIso();

  // Atomically update credit and obligation
  const updateCredit = await db
    .prepare(
      `UPDATE pilot_credits
          SET applied_to_obligation_id = ?, applied_at = ?
        WHERE id = ? AND applied_to_obligation_id IS NULL`,
    )
    .bind(args.obligationId, timestamp, args.creditId)
    .run();

  if (updateCredit.meta.changes === 0) {
    return refused('Khoản tín dụng thí điểm này đã bị sử dụng trong thao tác khác.', 409);
  }

  const nextStatus = credit.credit_amount_vnd >= obligation.amount_vnd ? 'settled' : 'partially_settled';
  await db
    .prepare(`UPDATE opc_obligations SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(nextStatus, timestamp, args.obligationId)
    .run();

  const updatedCredit = await db
    .prepare(`SELECT * FROM pilot_credits WHERE id = ?`)
    .bind(args.creditId)
    .first<PilotCreditRow>();
  const updatedObligation = await db
    .prepare(`SELECT * FROM opc_obligations WHERE id = ?`)
    .bind(args.obligationId)
    .first<OpcObligationRow>();

  if (updatedCredit === null || updatedObligation === null) {
    return refused('Không đọc lại được trạng thái sau khi khấu trừ tín dụng.', 500);
  }

  return ok({ credit: updatedCredit, obligation: updatedObligation });
}

/**
 * Computes the 3 distinct financial metrics (§13):
 * 1. Active MRR (Monthly Recurring Revenue): Active subscriptions only. Prepaid 12-month / 12. Setup/pilot fees EXCLUDED.
 * 2. Total Cash Collected in period: Confirmed non-reversed OPC receipts.
 * 3. Outstanding Receivables: Sum of unpaid obligations minus applied credits. Never conflated with MRR!
 */
export async function computeOpcFinancialMetrics(
  db: D1Like,
  workspaceId?: string,
): Promise<{
  active_mrr_vnd: number;
  cash_collected_vnd: number;
  outstanding_receivables_vnd: number;
}> {
  // 1. Active MRR
  let mrrQuery = `SELECT COALESCE(SUM(monthly_fee_vnd), 0) AS mrr FROM opc_agreements WHERE status = 'active'`;
  let mrrResult: { mrr: number } | null;
  if (workspaceId) {
    mrrResult = await db
      .prepare(`${mrrQuery} AND workspace_id = ?`)
      .bind(workspaceId)
      .first<{ mrr: number }>();
  } else {
    mrrResult = await db.prepare(mrrQuery).first<{ mrr: number }>();
  }
  const activeMrr = mrrResult?.mrr ?? 0;

  // 2. Cash Collected
  let cashQuery = `SELECT COALESCE(SUM(amount_vnd), 0) AS total FROM opc_receipts WHERE status = 'confirmed'`;
  let cashResult: { total: number } | null;
  if (workspaceId) {
    cashResult = await db
      .prepare(`${cashQuery} AND workspace_id = ?`)
      .bind(workspaceId)
      .first<{ total: number }>();
  } else {
    cashResult = await db.prepare(cashQuery).first<{ total: number }>();
  }
  const cashCollected = cashResult?.total ?? 0;

  // 3. Outstanding Receivables: recorded obligations that are not settled
  let obQuery = `SELECT id, amount_vnd FROM opc_obligations WHERE status IN ('pending', 'partially_settled')`;
  let obligations: { id: string; amount_vnd: number }[];
  if (workspaceId) {
    const { results } = await db
      .prepare(`${obQuery} AND workspace_id = ?`)
      .bind(workspaceId)
      .all<{ id: string; amount_vnd: number }>();
    obligations = results;
  } else {
    const { results } = await db.prepare(obQuery).all<{ id: string; amount_vnd: number }>();
    obligations = results;
  }

  let totalOutstanding = 0;
  for (const ob of obligations) {
    // subtract confirmed receipts allocated to this obligation
    const receiptSum = await db
      .prepare(`SELECT COALESCE(SUM(amount_vnd), 0) AS paid FROM opc_receipts WHERE obligation_id = ? AND status = 'confirmed'`)
      .bind(ob.id)
      .first<{ paid: number }>();
    // subtract credit applied
    const creditSum = await db
      .prepare(`SELECT COALESCE(SUM(credit_amount_vnd), 0) AS credited FROM pilot_credits WHERE applied_to_obligation_id = ?`)
      .bind(ob.id)
      .first<{ credited: number }>();

    const remaining = Math.max(0, ob.amount_vnd - (receiptSum?.paid ?? 0) - (creditSum?.credited ?? 0));
    totalOutstanding += remaining;
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

export async function runEconomicsScenarios(
  db: D1Like,
): Promise<{
  parameters: BusinessModelParameters;
  scenarios: EnrichedScenarioResult[];
}> {
  const active = await getActiveConfig(db, 'business_model');
  let params: BusinessModelParameters;

  if (active !== null) {
    params = active.parameters;
  } else {
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
  workspaceId?: string,
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
  const agreements = workspaceId
    ? (
        await db
          .prepare(`SELECT * FROM opc_agreements WHERE workspace_id = ? ORDER BY created_at DESC`)
          .bind(workspaceId)
          .all<OpcAgreementRow>()
      ).results
    : (await db.prepare(`SELECT * FROM opc_agreements ORDER BY created_at DESC`).all<OpcAgreementRow>()).results;

  const obligations = workspaceId
    ? (
        await db
          .prepare(`SELECT * FROM opc_obligations WHERE workspace_id = ? ORDER BY due_date ASC`)
          .bind(workspaceId)
          .all<OpcObligationRow>()
      ).results
    : (await db.prepare(`SELECT * FROM opc_obligations ORDER BY due_date ASC`).all<OpcObligationRow>()).results;

  const receipts = workspaceId
    ? (
        await db
          .prepare(`SELECT * FROM opc_receipts WHERE workspace_id = ? ORDER BY created_at DESC`)
          .bind(workspaceId)
          .all<OpcReceiptRow>()
      ).results
    : (await db.prepare(`SELECT * FROM opc_receipts ORDER BY created_at DESC`).all<OpcReceiptRow>()).results;

  const pilotCredits = workspaceId
    ? (
        await db
          .prepare(`SELECT * FROM pilot_credits WHERE workspace_id = ? ORDER BY created_at DESC`)
          .bind(workspaceId)
          .all<PilotCreditRow>()
      ).results
    : (await db.prepare(`SELECT * FROM pilot_credits ORDER BY created_at DESC`).all<PilotCreditRow>()).results;

  const metrics = await computeOpcFinancialMetrics(db, workspaceId);

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
    return refused(`Dung lượng tệp nhập vượt quá giới hạn 256 KiB (${byteLength} bytes).`, 400);
  }

  let totalObs = 0;
  for (const item of items) {
    if (envAppEnv === 'pilot' && item.data_origin === 'synthetic') {
      return refused(
        `Phỏng vấn "${item.external_id}" mang nguồn dữ liệu synthetic — bị từ chối trên môi trường Pilot.`,
        400,
      );
    }
    totalObs += item.observations.length;
    if (totalObs > MAX_IMPORT_OBSERVATIONS) {
      return refused(`Tổng số quan sát vượt quá ${MAX_IMPORT_OBSERVATIONS} dòng mỗi lần nhập.`, 400);
    }
    for (const obs of item.observations) {
      if (!ALLOWED_METRIC_KEYS.includes(obs.metric_key)) {
        return refused(
          `Phỏng vấn "${item.external_id}" có metric_key không thuộc danh mục cho phép: "${obs.metric_key}".`,
          400,
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

