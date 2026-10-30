/**
 * Real SQLite in-memory D1 harness using Node's built-in `node:sqlite`.
 *
 * Applies the actual migration SQL files in `MIGRATION_FILES` order and the
 * optional demo seed (`migrations/seed/demo.sql`), enforcing foreign keys,
 * partial unique indexes, and CHECK constraints identically to Cloudflare D1.
 * A new migration is added to the list, never merged into an earlier one, so
 * the test path is the upgrade path.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Like, D1PreparedStatement, D1Result } from '../src/ops/catalog.ts';

const ROOT = resolve(import.meta.dirname, '..');

export const MIGRATION_FILES = [
  'migrations/0001_init.sql',
  'migrations/0002_catalog_and_quotes.sql',
  'migrations/0003_b2b_marketplace_escrow.sql',
  'migrations/0004_part_a_ops_and_founder.sql',
  'migrations/0005_b2b_settlement_and_idempotency.sql',
  'migrations/0006_config_version_lineage.sql',
  'migrations/0007_audit_provisioning_actor.sql',
];

function createPreparedStatement(db: DatabaseSync, sql: string, boundValues: unknown[] = []): D1PreparedStatement {
  const toSqlParams = (vals: unknown[]): SQLInputValue[] =>
    vals.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
      if (v instanceof Uint8Array) return v;
      return String(v);
    });

  return {
    bind(...values: unknown[]): D1PreparedStatement {
      return createPreparedStatement(db, sql, values);
    },
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = stmt.get(...toSqlParams(boundValues)) as T | undefined;
      return row ?? null;
    },
    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      const stmt = db.prepare(sql);
      const results = stmt.all(...toSqlParams(boundValues)) as T[];
      return { results };
    },
    async run(): Promise<{ meta: { changes: number } }> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...toSqlParams(boundValues));
      return { meta: { changes: Number(info.changes) } };
    },
  };
}

export function createSqliteD1(options: { seedDemo?: boolean } = {}): {
  db: D1Like;
  raw: DatabaseSync;
} {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');

  for (const relPath of MIGRATION_FILES) {
    const sql = readFileSync(resolve(ROOT, relPath), 'utf8');
    raw.exec(sql);
  }

  if (options.seedDemo !== false) {
    const seedSql = readFileSync(resolve(ROOT, 'migrations/seed/demo.sql'), 'utf8');
    raw.exec(seedSql);
  }

  // D1 runs each `batch` as one transaction and never interleaves two of
  // them; on a single node:sqlite connection a second BEGIN inside an open
  // transaction would throw instead. Batches therefore queue here, so a test
  // that lets two calls' reads interleave (Promise.all) still sees two
  // serialized transactions — the shape a lost race takes on D1.
  let queue: Promise<unknown> = Promise.resolve();
  const runBatch = async (statements: D1PreparedStatement[]): Promise<unknown> => {
    raw.exec('BEGIN IMMEDIATE;');
    try {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      raw.exec('COMMIT;');
      return results;
    } catch (err) {
      raw.exec('ROLLBACK;');
      throw err;
    }
  };

  const db: D1Like = {
    prepare(query: string): D1PreparedStatement {
      return createPreparedStatement(raw, query);
    },
    batch<T>(statements: T[]): Promise<unknown> {
      const turn = queue.then(() => runBatch(statements as unknown as D1PreparedStatement[]));
      queue = turn.catch(() => undefined);
      return turn;
    },
  };

  return { db, raw };
}
