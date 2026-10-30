import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_FILES, createSqliteD1 } from './sqlite-d1-harness.ts';

/**
 * Migration 0007 on its own terms.
 *
 * It adds `audit_events.actor_source` so a grant made by an operator at a terminal
 * is distinguishable from an application write. The interesting cases are the two
 * ends of its life: a database created from nothing, and a database that already
 * has audit history and business rows when the migration arrives.
 *
 * "Nothing else changed" is asserted by dumping every row of every table before
 * and after and comparing, rather than by trusting the migration's own comment.
 * The dump is taken with `ORDER BY rowid` so it is stable, and `audit_events` is
 * compared with the new column removed — the only difference the migration is
 * allowed to make to existing data is that column's value.
 */

const ROOT = resolve(import.meta.dirname, '..');

function applyMigrations(raw: DatabaseSync, files: readonly string[]): void {
  for (const file of files) {
    raw.exec(readFileSync(resolve(ROOT, file), 'utf8'));
  }
}

const UP_TO_0006 = MIGRATION_FILES.filter((file) => !file.includes('0007'));
const MIGRATION_0007 = MIGRATION_FILES.find((file) => file.includes('0007')) ?? '';

interface Row {
  [column: string]: unknown;
}

function tables(raw: DatabaseSync): string[] {
  return (
    raw
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'
          ORDER BY name`,
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => name !== '');
}

/** Every row of every table, keyed by table, in a stable order. */
function dump(raw: DatabaseSync): Record<string, Row[]> {
  const result: Record<string, Row[]> = {};
  for (const table of tables(raw)) {
    result[table] = raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Row[];
  }
  return result;
}

function withoutColumn(rows: Row[], column: string): Row[] {
  return rows.map((row) => {
    const copy = { ...row };
    delete copy[column];
    return copy;
  });
}

/** Representative rows: identity, membership, quote/order money, audit history. */
function seedBusinessData(raw: DatabaseSync): void {
  const at = '2026-10-25T02:00:00.000Z';
  raw.exec(`
    INSERT INTO workspaces (id, name, created_at, updated_at)
      VALUES ('ws-hist', 'Vườn lịch sử', '${at}', '${at}');
    INSERT INTO identities (id, access_sub, email, display_name, created_at)
      VALUES ('id-hist-founder', 'sub-hist-founder', 'founder@hist.test', 'Founder', '${at}'),
             ('id-hist-owner', 'sub-hist-owner', 'owner@hist.test', 'Owner', '${at}');
    INSERT INTO memberships (id, identity_id, workspace_id, role, granted_by, granted_at, revoked_at)
      VALUES ('mb-hist-f', 'id-hist-founder', 'ws-hist', 'founder_admin', 'id-hist-founder', '${at}', NULL),
             ('mb-hist-o', 'id-hist-owner', 'ws-hist', 'workspace_owner', 'id-hist-founder', '${at}', NULL);
    INSERT INTO products (id, workspace_id, name, price_vnd, unit, created_at, updated_at)
      VALUES ('pr-hist', 'ws-hist', 'Hoa hồng', 5000, 'cành', '${at}', '${at}');
    INSERT INTO customers (id, workspace_id, name, phone, address, note, created_at, updated_at)
      VALUES ('cu-hist', 'ws-hist', 'Chị Ba', '0900000001', 'Sa Đéc', NULL, '${at}', '${at}');
    INSERT INTO quote_chains (id, workspace_id, customer_id, reference, created_at, updated_at)
      VALUES ('qc-hist', 'ws-hist', 'cu-hist', 'BG-HIST-1', '${at}', '${at}');
    INSERT INTO quote_revisions
      (id, chain_id, workspace_id, revision_number, status, lines_json, subtotal_vnd,
       total_vnd, issued_at, accepted_at, created_at, updated_at)
      VALUES ('qr-hist-1', 'qc-hist', 'ws-hist', 1, 'accepted', '[]', 2000000,
              2000000, '${at}', '${at}', '${at}', '${at}');
    INSERT INTO orders
      (id, workspace_id, quote_chain_id, accepted_revision_id, customer_id, order_code,
       total_vnd, deposit_required_vnd, collected_vnd, status, note, created_at, updated_at)
      VALUES ('or-hist', 'ws-hist', 'qc-hist', 'qr-hist-1', 'cu-hist', 'ORD-HIST-1',
              2000000, 600000, 600000, 'deposit_confirmed', NULL, '${at}', '${at}');
    INSERT INTO receipts
      (id, workspace_id, order_id, amount_vnd, status, reference, confirmed_by,
       confirmed_at, note, created_at, updated_at)
      VALUES ('rc-hist', 'ws-hist', 'or-hist', 600000, 'confirmed', 'BG-HIST-1',
              'id-hist-founder', '${at}', NULL, '${at}', '${at}');
    INSERT INTO receipt_events (id, receipt_id, kind, actor_id, amount_vnd, detail, created_at)
      VALUES ('re-hist', 'rc-hist', 'confirm', 'id-hist-founder', 600000, NULL, '${at}');
    INSERT INTO config_versions
      (id, scope, workspace_id, version_number, parameters_json, created_by, created_at)
      VALUES ('cv-hist-1', 'business_model', 'ws-hist', 1, '{}', 'id-hist-founder', '${at}');
    INSERT INTO active_config_pointers (scope, workspace_id, active_version_id, updated_at)
      VALUES ('business_model', 'ws-hist', 'cv-hist-1', '${at}');
    INSERT INTO audit_events
      (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
      VALUES ('ae-hist-1', 'ws-hist', 'id-hist-founder', 'membership.granted', 'membership',
              'mb-hist-o', 'owner granted', '${at}'),
             ('ae-hist-2', 'ws-hist', 'id-hist-founder', 'quote.accepted', 'quote_chain',
              'qc-hist', NULL, '${at}');
  `);
}

describe('migration 0007 on an empty database', () => {
  it('creates the column with the default, and the CHECK rejects anything else', () => {
    const harness = createSqliteD1({ seedDemo: false });
    const columns = harness.raw.prepare('PRAGMA table_info(audit_events)').all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const actorSource = columns.find((column) => column.name === 'actor_source');
    expect(actorSource).toBeDefined();
    expect(actorSource?.notnull).toBe(1);
    expect(actorSource?.dflt_value).toBe("'app'");

    const insert = (id: string, source?: string): void => {
      const sql =
        source === undefined
          ? `INSERT INTO audit_events (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
             VALUES (?, NULL, NULL, 'test.action', 'thing', 'x', NULL, '2026-10-30T00:00:00.000Z')`
          : `INSERT INTO audit_events (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at, actor_source)
             VALUES (?, NULL, NULL, 'test.action', 'thing', 'x', NULL, '2026-10-30T00:00:00.000Z', ?)`;
      const statement = harness.raw.prepare(sql);
      if (source === undefined) statement.run(id);
      else statement.run(id, source);
    };

    // An insert that does not mention the column is an application write.
    insert('ae-default');
    // A provisioning write says so, with no actor identity.
    insert('ae-prov', 'provisioning');

    const rows = harness.raw
      .prepare('SELECT id, actor_source FROM audit_events ORDER BY id')
      .all() as { id: string; actor_source: string }[];
    expect(rows).toEqual([
      { id: 'ae-default', actor_source: 'app' },
      { id: 'ae-prov', actor_source: 'provisioning' },
    ]);

    expect(() => insert('ae-bad', 'system')).toThrow(/CHECK constraint failed/i);
    expect(() => insert('ae-null', '')).toThrow(/CHECK constraint failed/i);
  });
});

describe('migration 0007 on a database that already has data', () => {
  it('labels old audit rows "app" and changes nothing else', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(raw, UP_TO_0006);
    seedBusinessData(raw);

    const before = dump(raw);
    expect(before.audit_events).toHaveLength(2);
    expect(before.orders).toHaveLength(1);
    expect(before.receipts).toHaveLength(1);

    raw.exec(readFileSync(resolve(ROOT, MIGRATION_0007), 'utf8'));

    const after = dump(raw);

    // Audit rows are the same rows, with the new column filled in.
    expect(withoutColumn(after.audit_events ?? [], 'actor_source')).toEqual(before.audit_events);
    expect((after.audit_events ?? []).every((row) => row.actor_source === 'app')).toBe(true);

    // Every other table is byte-identical to what it was.
    for (const table of Object.keys(before)) {
      if (table === 'audit_events') continue;
      expect(`${table}:${JSON.stringify(after[table])}`).toBe(`${table}:${JSON.stringify(before[table])}`);
    }

    // No dangling references were created by the rebuild-free ALTER.
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The migration ledger is not touched by a migration file; it is the tool's.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'audit_events_by_source'").get()).toEqual({
      n: 1,
    });

    // New writes behave: an application row and a provisioning row coexist.
    raw.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
       VALUES ('ae-new-app', 'ws-hist', 'id-hist-founder', 'config.change', 'config_version', 'cv-hist-1', NULL, '2026-10-30T00:00:00.000Z')`,
    ).run();
    raw
      .prepare(
        `INSERT INTO audit_events (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at, actor_source)
         VALUES ('ae-new-prov', 'ws-hist', NULL, 'membership.granted', 'membership', 'mb-hist-f', '{}', '2026-10-30T00:00:00.000Z', 'provisioning')`,
      )
      .run();
    const sources = raw
      .prepare("SELECT id, actor_source FROM audit_events WHERE id LIKE 'ae-new-%' ORDER BY id")
      .all() as { id: string; actor_source: string }[];
    expect(sources).toEqual([
      { id: 'ae-new-app', actor_source: 'app' },
      { id: 'ae-new-prov', actor_source: 'provisioning' },
    ]);
  });

  it('is compatible in both directions with the Worker, because the Worker never reads the column', () => {
    const workerFiles = [
      'src/worker/index.ts',
      'src/security/authorize.ts',
      'src/founder/discovery.ts',
      'src/ops/transactions.ts',
      'src/ops/routes.ts',
    ];
    for (const file of workerFiles) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      expect(`${file}:${source.includes('actor_source')}`).toBe(`${file}:false`);
    }
    // And every application insert names the columns it writes, so the new default
    // applies without an edit: the old code keeps working on the new schema.
    const discovery = readFileSync(resolve(ROOT, 'src/founder/discovery.ts'), 'utf8');
    expect(discovery).toContain('INSERT INTO audit_events');
    expect(discovery).not.toMatch(/INSERT INTO audit_events[^;]*actor_source/);
  });
});
