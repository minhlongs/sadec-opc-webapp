import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_FILES } from './sqlite-d1-harness.ts';

const ROOT = resolve(import.meta.dirname, '..');

const IDX_0009 = MIGRATION_FILES.findIndex((file) => file.includes('0009'));
const UP_TO_0008 = MIGRATION_FILES.slice(0, IDX_0009);
const MIGRATION_0009 = MIGRATION_FILES[IDX_0009] ?? '';

interface Row {
  [column: string]: unknown;
}

function applyMigrations(raw: DatabaseSync, files: readonly string[]): void {
  for (const file of files) {
    raw.exec(readFileSync(resolve(ROOT, file), 'utf8'));
  }
}

function dumpAllTables(raw: DatabaseSync): Record<string, Row[]> {
  const names = (
    raw
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'
          ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out: Record<string, Row[]> = {};
  for (const name of names) {
    out[name] = raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Row[];
  }
  return out;
}

describe('0009_receipt_void.sql', () => {
  it('upgrades a populated 0001..0008 database inside an implicit D1 transaction with zero row loss and intact foreign keys', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(raw, UP_TO_0008);
    raw.exec(readFileSync(resolve(ROOT, 'migrations/seed/demo.sql'), 'utf8'));

    const before = dumpAllTables(raw);
    expect(before.receipts?.length).toBeGreaterThan(0);
    expect(before.receipt_events?.length).toBeGreaterThan(0);
    expect(before.quote_revisions?.length).toBeGreaterThan(0);

    const sql0009 = readFileSync(resolve(ROOT, MIGRATION_0009), 'utf8');
    const executableSql = sql0009.replace(/--.*$/gm, '');
    expect(executableSql).not.toMatch(/PRAGMA\s+foreign_keys/i);
    expect(executableSql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/i);

    raw.exec('BEGIN IMMEDIATE;');
    raw.exec(sql0009);
    raw.exec('COMMIT;');

    const fkErrors = raw.prepare('PRAGMA foreign_key_check').all();
    expect(fkErrors).toEqual([]);
    const integrity = raw.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    expect(integrity).toEqual([{ integrity_check: 'ok' }]);

    const after = dumpAllTables(raw);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const table of Object.keys(before)) {
      expect(after[table]?.length).toBe(before[table]?.length);
    }

    // Existing receipts gain NULL void columns; existing quote_revisions gain NULL customer_snapshot_json.
    for (let i = 0; i < (before.receipts?.length ?? 0); i++) {
      expect(after.receipts?.[i]).toEqual({
        ...before.receipts?.[i],
        void_reason: null,
        voided_by: null,
        voided_at: null,
      });
    }
    for (let i = 0; i < (before.quote_revisions?.length ?? 0); i++) {
      expect(after.quote_revisions?.[i]).toEqual({
        ...before.quote_revisions?.[i],
        customer_snapshot_json: null,
      });
    }

    // Verify new 'voided' receipt status and 'void' receipt_events kind satisfy CHECK constraints.
    raw
      .prepare(
        `INSERT INTO receipts
           (id, workspace_id, order_id, amount_vnd, status, reference,
            void_reason, voided_by, voided_at, created_at, updated_at)
         VALUES
           ('rc-void-check', 'ws-demo-a', 'ord-demo-01', 100000, 'voided', 'VCB-VOID',
            'Nhập nhầm số tiền', 'id-demo-operator', '2026-11-18T00:00:00.000Z',
            '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO receipt_events
           (id, receipt_id, kind, actor_id, amount_vnd, detail, created_at)
         VALUES
           ('re-void-check', 'rc-void-check', 'void', 'id-demo-operator', 100000,
            'Hủy phiếu thu chờ: Nhập nhầm số tiền', '2026-11-18T00:00:00.000Z')`,
      )
      .run();
  });
});
