import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_FILES } from './sqlite-d1-harness.ts';

const ROOT = resolve(import.meta.dirname, '..');

const IDX_0008 = MIGRATION_FILES.findIndex((file) => file.includes('0008'));
const UP_TO_0007 = MIGRATION_FILES.slice(0, IDX_0008);
const MIGRATION_0008 = MIGRATION_FILES[IDX_0008] ?? '';

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

describe('0008_orders_workspace_order_code.sql', () => {
  it('upgrades a populated 0001..0007 database inside an implicit D1 transaction with zero row loss and intact foreign keys', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(raw, UP_TO_0007);
    raw.exec(readFileSync(resolve(ROOT, 'migrations/seed/demo.sql'), 'utf8'));

    const before = dumpAllTables(raw);
    expect(before.orders?.length).toBeGreaterThan(0);
    expect(before.receipts?.length).toBeGreaterThan(0);
    expect(before.deliveries?.length).toBeGreaterThan(0);
    expect(before.follow_up_tasks?.length).toBeGreaterThan(0);

    // Cloudflare D1 runs each migration inside an implicit transaction.
    raw.exec('BEGIN;\n' + readFileSync(resolve(ROOT, MIGRATION_0008), 'utf8') + '\nCOMMIT;');

    const fkErrors = raw.prepare('PRAGMA foreign_key_check').all();
    expect(fkErrors).toEqual([]);

    const after = dumpAllTables(raw);
    expect(after).toEqual(before);
  });

  it('permits identical order_code across two workspaces while refusing duplicate order_code within one workspace', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(raw, MIGRATION_FILES);
    raw.exec(readFileSync(resolve(ROOT, 'migrations/seed/demo.sql'), 'utf8'));

    const at = '2026-11-18T00:00:00.000Z';
    raw.exec(`
      INSERT INTO quote_chains (id, workspace_id, customer_id, reference, created_at, updated_at)
        VALUES ('qc-b-dupcode', 'ws-demo-b', 'cu-b-01', 'BG-DEMO-DUP', '${at}', '${at}'),
               ('qc-a-dupcode', 'ws-demo-a', 'cu-a-01', 'BG-DEMO-DUP-A', '${at}', '${at}');
      INSERT INTO quote_revisions (
        id, chain_id, workspace_id, revision_number, status, lines_json,
        subtotal_vnd, discount_vnd, total_vnd, created_at, updated_at
      ) VALUES
        ('qr-b-dupcode', 'qc-b-dupcode', 'ws-demo-b', 1, 'accepted', '[]', 1000000, 0, 1000000, '${at}', '${at}'),
        ('qr-a-dupcode', 'qc-a-dupcode', 'ws-demo-a', 1, 'accepted', '[]', 1000000, 0, 1000000, '${at}', '${at}');
    `);

    // ws-demo-a already owns order_code 'ORD-DEMO001' in demo.sql; ws-demo-b may also own 'ORD-DEMO001'.
    expect(() =>
      raw.exec(`
        INSERT INTO orders (
          id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
          order_code, total_vnd, deposit_required_vnd, status, created_at, updated_at
        ) VALUES (
          'ord-b-samecode', 'ws-demo-b', 'qc-b-dupcode', 'qr-b-dupcode', 'cu-b-01',
          'ORD-DEMO001', 1000000, 300000, 'pending_deposit', '${at}', '${at}'
        );
      `),
    ).not.toThrow();

    // Same workspace ('ws-demo-a') reusing 'ORD-DEMO001' is refused by UNIQUE (workspace_id, order_code).
    expect(() =>
      raw.exec(`
        INSERT INTO orders (
          id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
          order_code, total_vnd, deposit_required_vnd, status, created_at, updated_at
        ) VALUES (
          'ord-a-dupcode', 'ws-demo-a', 'qc-a-dupcode', 'qr-a-dupcode', 'cu-a-01',
          'ORD-DEMO001', 1000000, 300000, 'pending_deposit', '${at}', '${at}'
        );
      `),
    ).toThrow(/UNIQUE constraint failed: orders\.workspace_id, orders\.order_code/);
  });
});
