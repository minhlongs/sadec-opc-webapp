/**
 * Founder writes against a real SQLite schema (migrations 0001–0006 + demo
 * seed): the import is all-or-nothing, config versions are gated on the
 * active pointer, and the OPC ledger allocates money from the ledger's own
 * sums rather than from the one receipt in hand.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { D1Like } from '../src/ops/catalog.ts';
import {
  applyChangeProposal,
  applyPilotCredit,
  computeOpcFinancialMetrics,
  confirmOpcReceipt,
  createChangeProposal,
  createInitialConfigVersion,
  createOpcAgreement,
  createOrUpdateInterview,
  executeImportPlan,
  getActiveConfig,
  planInterviewImport,
  recordOpcObligation,
  rollbackConfig,
  runEconomicsScenarios,
  type ImportInterviewItem,
} from '../src/founder/discovery.ts';
import {
  handleApplyImportInterviews,
  handleApplyProposal,
  handleCreateProposal,
  handlePreviewImportInterviews,
  handleRollbackConfig,
  type FounderRequestContext,
} from '../src/founder/routes.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';

const ADMIN = 'id-demo-admin';

/** A D1 whose next `batch` is preceded by a raw mutation — a lost race. */
function racing(db: D1Like, before: () => void): D1Like {
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async <T>(statements: T[]) => {
      before();
      return db.batch(statements);
    },
  };
}

function founderCtx(db: D1Like, accessible: readonly string[] = ['ws-demo-a', 'ws-demo-b', 'ws-demo-c']): FounderRequestContext {
  return {
    workspaceId: 'ws-demo-a',
    actorId: ADMIN,
    role: 'founder_admin',
    db,
    appEnv: 'local',
    accessibleWorkspaceIds: async () => accessible,
    authorizeWorkspace: async (ws) => accessible.includes(ws),
  };
}

function interview(externalId: string, overrides: Partial<ImportInterviewItem> = {}): ImportInterviewItem {
  return {
    external_id: externalId,
    organization_alias: `Vườn ${externalId}`,
    respondent_role: 'Chủ vườn',
    interviewed_at: '2026-10-28',
    data_origin: 'synthetic',
    notes: null,
    observations: [
      {
        metric_key: 'willingness_to_pay_vnd',
        value_num: 2_000_000,
        unit: 'VND',
        period: 'month',
        evidence_kind: 'reported',
        source_ref: `Ghi âm ${externalId}`,
      },
    ],
    ...overrides,
  };
}

function count(raw: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  return (raw.prepare(sql).get(...params) as { n: number }).n;
}

describe('founder interview import: preview writes nothing, apply is one transaction', () => {
  it('preview plans creates, revisions and unchanged items without writing a row', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const before = {
      interviews: count(raw, `SELECT COUNT(*) AS n FROM founder_interviews`),
      observations: count(raw, `SELECT COUNT(*) AS n FROM founder_observations`),
      audits: count(raw, `SELECT COUNT(*) AS n FROM audit_events`),
    };

    const response = await handlePreviewImportInterviews(
      founderCtx(db),
      {
        items: [
          interview('INT-NEW-01'),
          // Same content as the seeded INT-SADEC-001 → unchanged.
          {
            external_id: 'INT-SADEC-001',
            organization_alias: 'DEMO — Nhà vườn Tân Quy Đông #1',
            respondent_role: 'Chủ vườn hoa kiểng 2.5 ha',
            interviewed_at: '2026-10-20',
            data_origin: 'synthetic',
            notes: 'Khảo sát nhu cầu quản lý báo giá sỉ và đặt cọc vụ Tết.',
            observations: [
              { metric_key: 'willingness_to_pay_vnd', value_num: 3000000, unit: 'VND', period: 'month', evidence_kind: 'reported', source_ref: 'Ghi âm phỏng vấn #1 phút 14' },
              { metric_key: 'support_hours_per_customer_month', value_num: 4, unit: 'hours', period: 'month', evidence_kind: 'assumption', source_ref: 'Ước tính hỗ trợ tại vườn' },
            ],
          },
          // Seeded INT-SADEC-003 with a changed observation → revision.
          {
            external_id: 'INT-SADEC-003',
            organization_alias: 'DEMO — Vườn Mai Tân Khánh Đông',
            respondent_role: 'Chủ vườn',
            interviewed_at: '2026-10-22',
            data_origin: 'synthetic',
            observations: [
              { metric_key: 'pilot_fee_vnd', value_num: 3500000, unit: 'VND', period: 'once', evidence_kind: 'reported', source_ref: 'Chủ vườn đồng ý gói pilot' },
            ],
          },
        ],
      },
      1024,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { preview: Record<string, unknown> & { items: Array<{ external_id: string; action: string }> } };
    expect(body.preview.valid).toBe(true);
    expect(body.preview.create_count).toBe(1);
    expect(body.preview.unchanged_count).toBe(1);
    expect(body.preview.revision_count).toBe(1);
    expect(body.preview.items.map((i) => [i.external_id, i.action])).toEqual([
      ['INT-NEW-01', 'create'],
      ['INT-SADEC-001', 'unchanged'],
      ['INT-SADEC-003', 'revise'],
    ]);

    expect(count(raw, `SELECT COUNT(*) AS n FROM founder_interviews`)).toBe(before.interviews);
    expect(count(raw, `SELECT COUNT(*) AS n FROM founder_observations`)).toBe(before.observations);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events`)).toBe(before.audits);
  });

  it('apply writes every item in one batch with one audit event naming the actor', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const response = await handleApplyImportInterviews(
      founderCtx(db),
      { items: [interview('INT-NEW-01'), interview('INT-NEW-02')] },
      1024,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { applied_count: number; audit_id: string; create_count: number };
    expect(body.applied_count).toBe(2);
    expect(body.create_count).toBe(2);

    expect(count(raw, `SELECT COUNT(*) AS n FROM founder_interviews WHERE external_id IN ('INT-NEW-01', 'INT-NEW-02')`)).toBe(2);
    const audit = raw
      .prepare(`SELECT actor_id, action, workspace_id, detail FROM audit_events WHERE id = ?`)
      .get(body.audit_id) as { actor_id: string; action: string; workspace_id: string | null; detail: string };
    expect(audit.actor_id).toBe(ADMIN);
    expect(audit.action).toBe('founder.interviews.imported');
    expect(audit.workspace_id).toBeNull();
    expect(JSON.parse(audit.detail)).toMatchObject({ create_count: 2, revise_count: 0, external_ids: ['INT-NEW-01', 'INT-NEW-02'] });
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'founder.interviews.imported'`)).toBe(1);
  });

  it('a batch with one invalid item writes none of the valid ones', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const response = await handleApplyImportInterviews(
      founderCtx(db),
      {
        items: [
          interview('INT-NEW-01'),
          // Real over a seeded synthetic interview is the forbidden transition.
          { ...interview('INT-SADEC-002'), data_origin: 'real' },
        ],
      },
      1024,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('validation');
    expect(count(raw, `SELECT COUNT(*) AS n FROM founder_interviews WHERE external_id = 'INT-NEW-01'`)).toBe(0);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'founder.interviews.imported'`)).toBe(0);
  });

  it('refuses a duplicate external_id inside one batch before reading anything', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const planned = await planInterviewImport(db, [interview('INT-DUP'), interview('INT-DUP')], ADMIN, 'local');
    expect(planned.kind).toBe('refused');
    expect(planned.status).toBe(400);
    expect(planned.message).toMatch(/xuất hiện nhiều lần/);
  });

  it('a plan whose interview moved under it writes nothing and reports a conflict', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const planned = await planInterviewImport(
      db,
      [interview('INT-NEW-01'), { ...interview('INT-SADEC-003'), notes: 'Ghi chú mới' }],
      ADMIN,
      'local',
    );
    expect(planned.kind).toBe('ok');
    if (planned.kind !== 'ok') return;

    const racy = racing(db, () => {
      // Someone else revised INT-SADEC-003 between the plan and the batch.
      raw.prepare(`UPDATE founder_interviews SET revision = revision + 1 WHERE external_id = 'INT-SADEC-003'`).run();
    });
    const executed = await executeImportPlan(racy, planned.value, { action: 'founder.interviews.imported' });
    expect(executed.kind).toBe('refused');
    expect(executed.status).toBe(409);
    expect(executed.code).toBe('conflict');
    expect(executed.message).toContain('INT-SADEC-003');

    // Neither the new interview nor the revision's observations landed.
    expect(count(raw, `SELECT COUNT(*) AS n FROM founder_interviews WHERE external_id = 'INT-NEW-01'`)).toBe(0);
    expect(count(raw, `SELECT COUNT(*) AS n FROM founder_observations WHERE interview_id = 'int-demo-03' AND revision = 2`)).toBe(0);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'founder.interviews.imported'`)).toBe(0);
  });

  it('a plan racing a create of the same external_id writes nothing', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const planned = await planInterviewImport(db, [interview('INT-NEW-01'), interview('INT-NEW-02')], ADMIN, 'local');
    if (planned.kind !== 'ok') throw new Error('plan failed');
    const racy = racing(db, () => {
      raw
        .prepare(
          `INSERT INTO founder_interviews (id, external_id, organization_alias, respondent_role, interviewed_at, data_origin, notes, recorded_by, revision, created_at, updated_at)
           VALUES ('int-race', 'INT-NEW-02', 'Khác', 'Khác', '2026-10-28', 'synthetic', NULL, 'id-demo-admin', 1, '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z')`,
        )
        .run();
    });
    const executed = await executeImportPlan(racy, planned.value, { action: 'founder.interviews.imported' });
    expect(executed.kind).toBe('refused');
    expect(executed.status).toBe(409);
    expect(count(raw, `SELECT COUNT(*) AS n FROM founder_interviews WHERE external_id = 'INT-NEW-01'`)).toBe(0);
  });

  it('a revision appends observations under the next revision and keeps the old ones', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const first = await createOrUpdateInterview(
      db,
      { external_id: 'INT-REV', organization_alias: 'A', respondent_role: 'R', interviewed_at: '2026-10-28', data_origin: 'synthetic', actorId: ADMIN },
      [{ metric_key: 'setup_hours_per_customer', value_num: 20, unit: 'hours', evidence_kind: 'measured', source_ref: 'đo lần 1' }],
      'local',
    );
    expect(first.kind).toBe('ok');
    // Only the evidence source changes: that is still a new revision, not "identical".
    const second = await createOrUpdateInterview(
      db,
      { external_id: 'INT-REV', organization_alias: 'A', respondent_role: 'R', interviewed_at: '2026-10-28', data_origin: 'synthetic', actorId: ADMIN },
      [{ metric_key: 'setup_hours_per_customer', value_num: 20, unit: 'hours', evidence_kind: 'measured', source_ref: 'đo lần 2' }],
      'local',
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.wasRevision).toBe(true);
    expect(second.value.revision).toBe(2);
    expect(count(raw, `SELECT COUNT(*) AS n FROM founder_observations WHERE interview_id = ? AND revision = 1`, second.value.id)).toBe(1);
    expect(count(raw, `SELECT COUNT(*) AS n FROM founder_observations WHERE interview_id = ? AND revision = 2`, second.value.id)).toBe(1);
    // The same content a third time is unchanged and writes nothing.
    const third = await createOrUpdateInterview(
      db,
      { external_id: 'INT-REV', organization_alias: 'A', respondent_role: 'R', interviewed_at: '2026-10-28', data_origin: 'synthetic', actorId: ADMIN },
      [{ metric_key: 'setup_hours_per_customer', value_num: 20, unit: 'hours', evidence_kind: 'measured', source_ref: 'đo lần 2' }],
      'local',
    );
    expect(third.kind).toBe('ok');
    if (third.kind !== 'ok') return;
    expect(third.value.wasRevision).toBe(false);
    expect(third.value.revision).toBe(2);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'founder.interview.recorded'`)).toBe(2);
  });
});

describe('config proposals and versions', () => {
  it('a proposal must cite existing observations and a reason', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const base = { scope: 'business_model' as const, baseVersionId: null, changes: { monthly_fee_vnd: 3_200_000 }, rationale: 'Khảo sát 3 vườn chấp nhận mức mới', proposedBy: ADMIN };

    const none = await createChangeProposal(db, { ...base, evidenceIds: [] });
    expect(none.kind).toBe('refused');
    expect(none.status).toBe(400);

    const ghost = await createChangeProposal(db, { ...base, evidenceIds: ['obs-nope'] });
    expect(ghost.kind).toBe('refused');
    expect(ghost.message).toContain('obs-nope');

    const blank = await createChangeProposal(db, { ...base, evidenceIds: ['obs-demo-01'], rationale: '   ' });
    expect(blank.kind).toBe('refused');

    const created = await createChangeProposal(db, { ...base, evidenceIds: ['obs-demo-01'] });
    expect(created.kind).toBe('ok');
    if (created.kind !== 'ok') return;
    // The base version defaults to the active one, so apply can detect staleness.
    expect(created.value.base_version_id).toBe('cv-demo-bm-v1');
    expect(JSON.parse(created.value.evidence_ids_json)).toEqual(['obs-demo-01']);
  });

  it('the route refuses a workspace_operations proposal for a workspace the founder does not administer', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const response = await handleCreateProposal(founderCtx(db, ['ws-demo-a']), {
      scope: 'workspace_operations',
      workspace_id: 'ws-demo-b',
      changes: { support_hours_per_customer_month: 2 },
      evidence_ids: ['obs-demo-02'],
      rationale: 'Thử vượt ranh giới',
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('forbidden');
  });

  it('apply is gated on the active pointer: a concurrent publish loses cleanly, nothing half-written', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const applied = await applyChangeProposal(db, { proposalId: 'cp-demo-01', actorId: ADMIN });
    expect(applied.kind).toBe('ok');
    if (applied.kind !== 'ok') return;
    expect(applied.value.version.version_number).toBe(2);
    expect(applied.value.version.parameters.support_hours_per_customer_month).toBe(3);
    const audit = raw
      .prepare(`SELECT actor_id, detail FROM audit_events WHERE action = 'config.applied' AND subject_id = ?`)
      .get(applied.value.version.id) as { actor_id: string; detail: string };
    expect(audit.actor_id).toBe(ADMIN);
    expect(JSON.parse(audit.detail)).toMatchObject({ proposal_id: 'cp-demo-01', base_version_id: 'cv-demo-bm-v1', evidence_ids: ['obs-demo-02', 'obs-demo-03'] });

    // Applying the same proposal again is refused and writes nothing more.
    const again = await applyChangeProposal(db, { proposalId: 'cp-demo-01', actorId: ADMIN });
    expect(again.kind).toBe('refused');
    expect(again.status).toBe(409);
    expect(count(raw, `SELECT COUNT(*) AS n FROM config_versions WHERE scope = 'business_model'`)).toBe(2);

    // Two proposals on v2; the second apply races a pointer move and is refused inside the batch.
    const p1 = await createChangeProposal(db, { scope: 'business_model', baseVersionId: null, changes: { sales_hours_per_month: 20 }, evidenceIds: ['obs-demo-01'], rationale: 'A', proposedBy: ADMIN });
    if (p1.kind !== 'ok') throw new Error('p1');
    const racy = racing(db, () => {
      raw.prepare(`UPDATE active_config_pointers SET active_version_id = 'cv-demo-bm-v1' WHERE scope = 'business_model' AND workspace_id = 'global'`).run();
    });
    const lost = await applyChangeProposal(racy, { proposalId: p1.value.id, actorId: ADMIN });
    expect(lost.kind).toBe('refused');
    expect(lost.status).toBe(409);
    expect(lost.code).toBe('conflict');
    expect(count(raw, `SELECT COUNT(*) AS n FROM config_versions WHERE scope = 'business_model'`)).toBe(2);
    expect((raw.prepare(`SELECT status FROM change_proposals WHERE id = ?`).get(p1.value.id) as { status: string }).status).toBe('draft');
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'config.applied'`)).toBe(1);
  });

  it('the database refuses a duplicate global version number even without the application gate', () => {
    const { raw } = createSqliteD1({ seedDemo: true });
    expect(() =>
      raw
        .prepare(
          `INSERT INTO config_versions (id, scope, workspace_id, version_number, parameters_json, proposal_id, created_by, created_at)
           VALUES ('cv-dup', 'business_model', NULL, 1, '{}', NULL, 'id-demo-admin', '2026-10-28T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('rollback copies a version of the same scope and workspace, links the source, and leaves history intact', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const applied = await applyChangeProposal(db, { proposalId: 'cp-demo-01', actorId: ADMIN });
    if (applied.kind !== 'ok') throw new Error('apply');

    const rolled = await rollbackConfig(db, { scope: 'business_model', targetVersionId: 'cv-demo-bm-v1', actorId: ADMIN });
    expect(rolled.kind).toBe('ok');
    if (rolled.kind !== 'ok') return;
    expect(rolled.value.version_number).toBe(3);
    expect(rolled.value.restored_from_version_id).toBe('cv-demo-bm-v1');
    expect(rolled.value.parameters.support_hours_per_customer_month).toBe(4);

    const row = raw
      .prepare(`SELECT restored_from_version_id, parameters_json FROM config_versions WHERE id = ?`)
      .get(rolled.value.id) as { restored_from_version_id: string; parameters_json: string };
    expect(row.restored_from_version_id).toBe('cv-demo-bm-v1');
    expect(row.parameters_json).toBe((raw.prepare(`SELECT parameters_json FROM config_versions WHERE id = 'cv-demo-bm-v1'`).get() as { parameters_json: string }).parameters_json);
    // v1 and v2 are untouched.
    expect(count(raw, `SELECT COUNT(*) AS n FROM config_versions WHERE scope = 'business_model'`)).toBe(3);
    expect((raw.prepare(`SELECT version_number FROM config_versions WHERE id = ?`).get(applied.value.version.id) as { version_number: number }).version_number).toBe(2);
    const audit = raw
      .prepare(`SELECT actor_id, detail FROM audit_events WHERE action = 'config.rollback' AND subject_id = ?`)
      .get(rolled.value.id) as { actor_id: string; detail: string };
    expect(audit.actor_id).toBe(ADMIN);
    expect(JSON.parse(audit.detail)).toMatchObject({ rolled_back_from: 'cv-demo-bm-v1', left_version_id: applied.value.version.id });

    // Rolling back to the version that is already active is a state refusal.
    const same = await rollbackConfig(db, { scope: 'business_model', targetVersionId: rolled.value.id, actorId: ADMIN });
    expect(same.kind).toBe('refused');
    expect(same.status).toBe(409);
  });

  it('rollback refuses a version from another scope or workspace', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const wsVersion = await createInitialConfigVersion(
      db,
      'workspace_operations',
      'ws-demo-b',
      JSON.parse((raw.prepare(`SELECT parameters_json FROM config_versions WHERE id = 'cv-demo-bm-v1'`).get() as { parameters_json: string }).parameters_json),
      ADMIN,
    );
    expect(wsVersion).not.toBeNull();
    // The global scope may not restore a workspace's version, nor may workspace A restore B's.
    const crossScope = await rollbackConfig(db, { scope: 'business_model', targetVersionId: wsVersion!.id, actorId: ADMIN });
    expect(crossScope.kind).toBe('refused');
    expect(crossScope.status).toBe(404);
    const crossWorkspace = await rollbackConfig(db, { scope: 'workspace_operations', workspaceId: 'ws-demo-a', targetVersionId: wsVersion!.id, actorId: ADMIN });
    expect(crossWorkspace.kind).toBe('refused');
    expect(crossWorkspace.status).toBe(404);
  });

  it('rollback racing a pointer move writes nothing', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const applied = await applyChangeProposal(db, { proposalId: 'cp-demo-01', actorId: ADMIN });
    if (applied.kind !== 'ok') throw new Error('apply');
    const racy = racing(db, () => {
      raw.prepare(`UPDATE active_config_pointers SET active_version_id = 'cv-demo-bm-v1' WHERE scope = 'business_model' AND workspace_id = 'global'`).run();
    });
    const lost = await rollbackConfig(racy, { scope: 'business_model', targetVersionId: 'cv-demo-bm-v1', actorId: ADMIN });
    expect(lost.kind).toBe('refused');
    expect(lost.status).toBe(409);
    expect(count(raw, `SELECT COUNT(*) AS n FROM config_versions WHERE scope = 'business_model'`)).toBe(2);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'config.rollback'`)).toBe(0);
  });

  it('the routes resolve a tenant proposal and rollback through the chokepoint', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const params = JSON.parse((raw.prepare(`SELECT parameters_json FROM config_versions WHERE id = 'cv-demo-bm-v1'`).get() as { parameters_json: string }).parameters_json);
    const v1 = await createInitialConfigVersion(db, 'workspace_operations', 'ws-demo-b', params, ADMIN);
    expect(v1).not.toBeNull();

    // An admin of A only may not apply B's proposal.
    const proposal = await createChangeProposal(db, { scope: 'workspace_operations', workspaceId: 'ws-demo-b', baseVersionId: null, changes: { support_hours_per_customer_month: 2 }, evidenceIds: ['obs-demo-02'], rationale: 'B', proposedBy: ADMIN });
    if (proposal.kind !== 'ok') throw new Error('proposal');
    const denied = await handleApplyProposal(founderCtx(db, ['ws-demo-a']), { proposal_id: proposal.value.id });
    expect(denied.status).toBe(403);
    expect((raw.prepare(`SELECT status FROM change_proposals WHERE id = ?`).get(proposal.value.id) as { status: string }).status).toBe('draft');

    const allowed = await handleApplyProposal(founderCtx(db), { proposal_id: proposal.value.id });
    expect(allowed.status).toBe(200);

    const rollbackDenied = await handleRollbackConfig(founderCtx(db, ['ws-demo-a']), { scope: 'workspace_operations', workspace_id: 'ws-demo-b', target_version_id: v1!.id });
    expect(rollbackDenied.status).toBe(403);
    const rollbackOk = await handleRollbackConfig(founderCtx(db), { scope: 'workspace_operations', workspace_id: 'ws-demo-b', target_version_id: v1!.id });
    expect(rollbackOk.status).toBe(200);
    const active = await getActiveConfig(db, 'workspace_operations', 'ws-demo-b');
    expect(active?.version.version_number).toBe(3);
    expect(active?.version.restored_from_version_id).toBe(v1!.id);
  });

  it('bootstrapping version 1 twice produces one version', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const params = JSON.parse((raw.prepare(`SELECT parameters_json FROM config_versions WHERE id = 'cv-demo-bm-v1'`).get() as { parameters_json: string }).parameters_json);
    const first = await createInitialConfigVersion(db, 'workspace_operations', 'ws-demo-c', params, ADMIN);
    const second = await createInitialConfigVersion(db, 'workspace_operations', 'ws-demo-c', params, ADMIN);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(count(raw, `SELECT COUNT(*) AS n FROM config_versions WHERE scope = 'workspace_operations' AND workspace_id = 'ws-demo-c'`)).toBe(1);
  });

  it('economics names the parameter source and never a measured business', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const econ = await runEconomicsScenarios(db);
    expect(econ.parameters_source).toMatchObject({ kind: 'config_version', version_id: 'cv-demo-bm-v1', version_number: 1 });
    // N=5, S=0 with the seeded parameters: revenue 15,000,000; cash cost 5×350,000 + 2,500,000 = 4,250,000.
    const n5 = econ.scenarios[0]!;
    expect(n5.revenue_vnd).toBe(15_000_000);
    expect(n5.cash_cost_vnd).toBe(4_250_000);
    expect(n5.cash_surplus_vnd).toBe(10_750_000);
    expect(n5.hours).toBe(5 * 4 + 24 + 16 + 16 + 16);
    expect(n5.founder_value_vnd).toBe(n5.hours * 150_000);
  });
});

describe('OPC ledger: obligations are settled from the ledger, not from one receipt', () => {
  async function freshAgreement(db: D1Like) {
    const ag = await createOpcAgreement(db, { workspaceId: 'ws-demo-b', monthlyFeeVnd: 3_000_000, setupFeeVnd: 10_000_000, effectiveDate: '2026-11-01', pricePlaneSnapshot: {}, actorId: ADMIN });
    if (ag.kind !== 'ok') throw new Error(ag.message);
    const ob = await recordOpcObligation(db, { agreementId: ag.value.id, workspaceId: 'ws-demo-b', obligationKind: 'setup_fee', amountVnd: 10_000_000, dueDate: '2026-11-20', actorId: ADMIN });
    if (ob.kind !== 'ok') throw new Error(ob.message);
    return { agreement: ag.value, obligation: ob.value };
  }

  it('agreement and obligation writes carry an audit event with the actor', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const { agreement, obligation } = await freshAgreement(db);
    const ag = raw.prepare(`SELECT actor_id, workspace_id FROM audit_events WHERE action = 'opc.agreement.created' AND subject_id = ?`).get(agreement.id) as { actor_id: string; workspace_id: string };
    expect(ag).toMatchObject({ actor_id: ADMIN, workspace_id: 'ws-demo-b' });
    const ob = raw.prepare(`SELECT actor_id FROM audit_events WHERE action = 'opc.obligation.recorded' AND subject_id = ?`).get(obligation.id) as { actor_id: string };
    expect(ob.actor_id).toBe(ADMIN);
    // A second agreement for the same workspace is refused.
    const dup = await createOpcAgreement(db, { workspaceId: 'ws-demo-b', monthlyFeeVnd: 1, setupFeeVnd: 1, effectiveDate: '2026-11-01', pricePlaneSnapshot: {}, actorId: ADMIN });
    expect(dup.kind).toBe('refused');
    expect(dup.status).toBe(409);
  });

  it('two partial receipts settle the obligation exactly once covered; a third is refused as over-allocation', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const { agreement, obligation } = await freshAgreement(db);
    const base = { receiptId: '', agreementId: agreement.id, workspaceId: 'ws-demo-b', obligationId: obligation.id, feeType: 'setup_fee' as const, confirmedBy: ADMIN };

    const first = await confirmOpcReceipt(db, { ...base, amountVnd: 6_000_000, reference: 'CK-1' });
    expect(first.kind).toBe('ok');
    expect((raw.prepare(`SELECT status FROM opc_obligations WHERE id = ?`).get(obligation.id) as { status: string }).status).toBe('partially_settled');

    const tooMuch = await confirmOpcReceipt(db, { ...base, amountVnd: 4_000_001, reference: 'CK-2x' });
    expect(tooMuch.kind).toBe('refused');
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.code).toBe('invalid_state');
    expect(count(raw, `SELECT COUNT(*) AS n FROM opc_receipts WHERE reference = 'CK-2x'`)).toBe(0);

    const second = await confirmOpcReceipt(db, { ...base, amountVnd: 4_000_000, reference: 'CK-2' });
    expect(second.kind).toBe('ok');
    expect((raw.prepare(`SELECT status FROM opc_obligations WHERE id = ?`).get(obligation.id) as { status: string }).status).toBe('settled');

    const third = await confirmOpcReceipt(db, { ...base, amountVnd: 1, reference: 'CK-3' });
    expect(third.kind).toBe('refused');
    expect(third.status).toBe(409);

    const metrics = await computeOpcFinancialMetrics(db, 'ws-demo-b');
    expect(metrics).toEqual({ active_mrr_vnd: 3_000_000, cash_collected_vnd: 10_000_000, outstanding_receivables_vnd: 0 });
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'opc.receipt.confirmed' AND actor_id = ?`, ADMIN)).toBe(2);
  });

  it('a receipt racing another on the same obligation cannot over-allocate', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const { agreement, obligation } = await freshAgreement(db);
    const racy = racing(db, () => {
      raw
        .prepare(
          `INSERT INTO opc_receipts (id, agreement_id, workspace_id, obligation_id, amount_vnd, fee_type, reference, status, confirmed_by, confirmed_at, note, created_at, updated_at)
           VALUES ('opcrc-race', ?, 'ws-demo-b', ?, 7000000, 'setup_fee', 'RACE', 'confirmed', 'id-demo-admin', '2026-10-28T00:00:00.000Z', NULL, '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z')`,
        )
        .run(agreement.id, obligation.id);
    });
    const result = await confirmOpcReceipt(racy, { receiptId: '', agreementId: agreement.id, workspaceId: 'ws-demo-b', obligationId: obligation.id, amountVnd: 5_000_000, feeType: 'setup_fee', reference: 'CK-LATE', confirmedBy: ADMIN });
    expect(result.kind).toBe('refused');
    expect(result.status).toBe(409);
    expect(result.message).toContain('3.000.000');
    expect(count(raw, `SELECT COUNT(*) AS n FROM opc_receipts WHERE obligation_id = ?`, obligation.id)).toBe(1);
  });

  it('a receipt cannot be filed against an obligation of another workspace or agreement', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const { agreement } = await freshAgreement(db);
    // ob-demo-m11 belongs to ws-demo-a / ag-demo-a.
    const foreign = await confirmOpcReceipt(db, { receiptId: '', agreementId: agreement.id, workspaceId: 'ws-demo-b', obligationId: 'ob-demo-m11', amountVnd: 1_000_000, feeType: 'monthly_subscription', reference: 'X', confirmedBy: ADMIN });
    expect(foreign.kind).toBe('refused');
    expect(foreign.status).toBe(404);
    expect(count(raw, `SELECT COUNT(*) AS n FROM opc_receipts WHERE obligation_id = 'ob-demo-m11'`)).toBe(0);
    // A client-chosen receipt id that already exists is a conflict, not a replay.
    const taken = await confirmOpcReceipt(db, { receiptId: 'opcrc-demo-pilot', agreementId: agreement.id, workspaceId: 'ws-demo-b', amountVnd: 1, feeType: 'other', reference: 'Y', confirmedBy: ADMIN });
    expect(taken.kind).toBe('refused');
    expect(taken.status).toBe(409);
    expect(taken.code).toBe('conflict');
  });

  it('a pilot credit is applied once, within the remaining amount, in one transaction with its audit event', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const { agreement, obligation } = await freshAgreement(db);
    const pilotOb = await recordOpcObligation(db, { agreementId: agreement.id, workspaceId: 'ws-demo-b', obligationKind: 'pilot_fee', amountVnd: 3_000_000, dueDate: '2026-11-05', actorId: ADMIN });
    if (pilotOb.kind !== 'ok') throw new Error('pilot ob');
    const pilotReceipt = await confirmOpcReceipt(db, { receiptId: '', agreementId: agreement.id, workspaceId: 'ws-demo-b', obligationId: pilotOb.value.id, amountVnd: 3_000_000, feeType: 'pilot_fee', reference: 'PILOT', confirmedBy: ADMIN });
    if (pilotReceipt.kind !== 'ok' || pilotReceipt.value.pilotCredit === undefined) throw new Error('pilot receipt');
    const credit = pilotReceipt.value.pilotCredit;
    expect((raw.prepare(`SELECT status FROM opc_obligations WHERE id = ?`).get(pilotOb.value.id) as { status: string }).status).toBe('settled');

    // 8,000,000 already received: the 3,000,000 credit exceeds the 2,000,000 left → refused, nothing consumed.
    const big = await confirmOpcReceipt(db, { receiptId: '', agreementId: agreement.id, workspaceId: 'ws-demo-b', obligationId: obligation.id, amountVnd: 8_000_000, feeType: 'setup_fee', reference: 'CK-8', confirmedBy: ADMIN });
    expect(big.kind).toBe('ok');
    const tooBig = await applyPilotCredit(db, { creditId: credit.id, obligationId: obligation.id, workspaceId: 'ws-demo-b', actorId: ADMIN });
    expect(tooBig.kind).toBe('refused');
    expect(tooBig.status).toBe(409);
    expect((raw.prepare(`SELECT applied_to_obligation_id FROM pilot_credits WHERE id = ?`).get(credit.id) as { applied_to_obligation_id: string | null }).applied_to_obligation_id).toBeNull();

    // A fresh 5,000,000 obligation takes the credit; status recomputed from the ledger.
    const monthly = await recordOpcObligation(db, { agreementId: agreement.id, workspaceId: 'ws-demo-b', obligationKind: 'monthly_subscription', amountVnd: 5_000_000, dueDate: '2026-12-05', actorId: ADMIN });
    if (monthly.kind !== 'ok') throw new Error('monthly');
    const applied = await applyPilotCredit(db, { creditId: credit.id, obligationId: monthly.value.id, workspaceId: 'ws-demo-b', actorId: ADMIN });
    expect(applied.kind).toBe('ok');
    if (applied.kind !== 'ok') return;
    expect(applied.value.obligation.status).toBe('partially_settled');
    const audit = raw.prepare(`SELECT actor_id, detail FROM audit_events WHERE action = 'opc.pilot_credit.applied' AND subject_id = ?`).get(credit.id) as { actor_id: string; detail: string };
    expect(audit.actor_id).toBe(ADMIN);
    expect(JSON.parse(audit.detail)).toMatchObject({ obligation_id: monthly.value.id, credit_amount_vnd: 3_000_000 });

    // Second application is refused; nothing more is written.
    const again = await applyPilotCredit(db, { creditId: credit.id, obligationId: monthly.value.id, workspaceId: 'ws-demo-b', actorId: ADMIN });
    expect(again.kind).toBe('refused');
    expect(again.status).toBe(409);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'opc.pilot_credit.applied'`)).toBe(1);

    // The remaining 2,000,000 settles with a receipt; a credit is not cash collected.
    const rest = await confirmOpcReceipt(db, { receiptId: '', agreementId: agreement.id, workspaceId: 'ws-demo-b', obligationId: monthly.value.id, amountVnd: 2_000_000, feeType: 'monthly_subscription', reference: 'CK-M', confirmedBy: ADMIN });
    expect(rest.kind).toBe('ok');
    expect((raw.prepare(`SELECT status FROM opc_obligations WHERE id = ?`).get(monthly.value.id) as { status: string }).status).toBe('settled');
    const metrics = await computeOpcFinancialMetrics(db, 'ws-demo-b');
    expect(metrics.cash_collected_vnd).toBe(3_000_000 + 8_000_000 + 2_000_000);
    expect(metrics.outstanding_receivables_vnd).toBe(2_000_000); // setup fee: 10,000,000 − 8,000,000
  });

  it('a credit racing its own application is consumed once', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const { agreement, obligation } = await freshAgreement(db);
    const pilotReceipt = await confirmOpcReceipt(db, { receiptId: '', agreementId: agreement.id, workspaceId: 'ws-demo-b', amountVnd: 3_000_000, feeType: 'pilot_fee', reference: 'PILOT', confirmedBy: ADMIN });
    if (pilotReceipt.kind !== 'ok' || pilotReceipt.value.pilotCredit === undefined) throw new Error('pilot receipt');
    const credit = pilotReceipt.value.pilotCredit;
    const racy = racing(db, () => {
      raw.prepare(`UPDATE pilot_credits SET applied_to_obligation_id = ?, applied_at = '2026-10-28T00:00:00.000Z' WHERE id = ?`).run(obligation.id, credit.id);
    });
    const lost = await applyPilotCredit(racy, { creditId: credit.id, obligationId: obligation.id, workspaceId: 'ws-demo-b', actorId: ADMIN });
    expect(lost.kind).toBe('refused');
    expect(lost.status).toBe(409);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'opc.pilot_credit.applied'`)).toBe(0);
  });

  it('the seeded ledger reads as documented: 10,000,000 collected, 3,000,000 outstanding for ws-demo-a', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const metrics = await computeOpcFinancialMetrics(db, 'ws-demo-a');
    expect(metrics).toEqual({ active_mrr_vnd: 3_000_000, cash_collected_vnd: 10_000_000, outstanding_receivables_vnd: 3_000_000 });
  });
});

describe('migration 0006 upgrade path', () => {
  it('backfills restored_from_version_id from the rollback audit events the old code wrote', () => {
    const root = resolve(import.meta.dirname, '..');
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON;');
    for (const file of [
      'migrations/0001_init.sql',
      'migrations/0002_catalog_and_quotes.sql',
      'migrations/0003_b2b_marketplace_escrow.sql',
      'migrations/0004_part_a_ops_and_founder.sql',
      'migrations/0005_b2b_settlement_and_idempotency.sql',
    ]) {
      raw.exec(readFileSync(resolve(root, file), 'utf8'));
    }
    raw.exec(readFileSync(resolve(root, 'migrations/seed/demo.sql'), 'utf8'));
    // A rollback recorded under 0005: version 2 copies version 1, linked only by the audit row.
    raw
      .prepare(
        `INSERT INTO config_versions (id, scope, workspace_id, version_number, parameters_json, proposal_id, created_by, created_at)
         SELECT 'cv-old-rollback', 'business_model', NULL, 2, parameters_json, NULL, 'id-demo-admin', '2026-10-27T00:00:00.000Z'
           FROM config_versions WHERE id = 'cv-demo-bm-v1'`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO audit_events (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         VALUES ('ae-old-rollback', NULL, 'id-demo-admin', 'config.rollback', 'config_version', 'cv-old-rollback',
                 '{"rolled_back_from":"cv-demo-bm-v1","target_version_number":1}', '2026-10-27T00:00:00.000Z')`,
      )
      .run();

    raw.exec(readFileSync(resolve(root, 'migrations/0006_config_version_lineage.sql'), 'utf8'));

    const rows = raw
      .prepare(`SELECT id, restored_from_version_id FROM config_versions WHERE scope = 'business_model' ORDER BY version_number`)
      .all() as Array<{ id: string; restored_from_version_id: string | null }>;
    expect(rows).toEqual([
      { id: 'cv-demo-bm-v1', restored_from_version_id: null },
      { id: 'cv-old-rollback', restored_from_version_id: 'cv-demo-bm-v1' },
    ]);
    // And the partial unique index now stands.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO config_versions (id, scope, workspace_id, version_number, parameters_json, proposal_id, created_by, created_at, restored_from_version_id)
           VALUES ('cv-dup', 'business_model', NULL, 2, '{}', NULL, 'id-demo-admin', '2026-10-28T00:00:00.000Z', NULL)`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });
});
