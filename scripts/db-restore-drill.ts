#!/usr/bin/env node
/**
 * Proves a specific backup file can actually be restored, without touching any
 * live database.
 *
 * Why this is a separate command from `db:restore:test`:
 *
 *   - `db:restore:test` restores into a **scratch binding of the test database**
 *     through wrangler. That is the right shape for the suite's database, and the
 *     wrong shape for a pilot backup, because a pilot restore target would be a
 *     second remote D1 — a resource the repository does not declare and a
 *     deployment must not invent.
 *   - This command replays the file into a throwaway SQLite file on the machine
 *     running it. Nothing remote is read or written. What it proves is exactly
 *     the property a backup needs: the file, as exported, replays completely,
 *     keeps its foreign keys satisfied and its integrity intact, and still holds
 *     the rows the evidence depends on.
 *
 * The file is required, and it is required **explicitly**. There is no "newest
 * backup" default here, on purpose: a drill that silently picked the most recent
 * file would, on a machine that had just run a test backup, prove the wrong file
 * — and report the pilot's backup as verified. The caller names the file, which
 * is why the deploy workflow can pass the exact artefact it produced moments
 * earlier in the same job.
 *
 * The environment still goes through the shared guard, and the file's name must
 * carry the environment's binding name, so a test backup cannot be drilled as a
 * pilot one by accident.
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bindingNameFor, printTarget, requireEnvironment } from './require-environment.ts';
import { orderedForDrop, stripMigrationLedger } from './restore-sql.ts';

const environment = requireEnvironment(process, 'db:restore:drill');
const binding = bindingNameFor(environment);

// The tables whose contents are the point of a backup: identity and access,
// the quote → order → receipt chain, the escrow row, configuration lineage and
// the audit trail. A replay that loses one of these is not a recovery.
const EVIDENCE_TABLES = [
  'workspaces',
  'identities',
  'memberships',
  'quote_revisions',
  'orders',
  'receipts',
  'receipt_events',
  'escrow_ledger_entries',
  'config_versions',
  'audit_events',
] as const;

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

const source = flagValue('--file');

if (source === null) {
  process.stderr.write(
    `\nError: db:restore:drill requires --file <path to the backup it must prove>.\n\n` +
      'There is deliberately no "newest backup" default. Name the file: a drill\n' +
      'on the wrong file reports the wrong artefact as verified.\n',
  );
  process.exit(2);
}

if (source.includes('.replay.') || source.includes('.drill.')) {
  process.stderr.write(
    `\nError: ${source} is a file this tooling wrote, not an export to prove.\n` +
      'Drill the backup `wrangler d1 export` produced.\n',
  );
  process.exit(2);
}

if (!existsSync(source)) {
  process.stderr.write(`\nError: no such file: ${source}\n`);
  process.exit(2);
}

const name = basename(source);
if (!name.startsWith(`${binding}-`)) {
  process.stderr.write(
    `\nError: ${name} does not belong to ${binding}.\n\n` +
      `A backup for this environment is named ${binding}-<timestamp>.sql. Drilling a\n` +
      'file from another environment would prove the wrong database restorable.\n',
  );
  process.exit(2);
}

if (!name.endsWith('.sql')) {
  process.stderr.write(`\nError: ${name} is not an .sql export.\n`);
  process.exit(2);
}

const scratch = join('backups', `${name.replace(/\.sql$/, '')}.drill.sqlite`);

printTarget(process, {
  command: 'db:restore:drill',
  environment,
  database: 'local scratch SQLite (no remote database is touched)',
  extra: [
    `Source:      ${source} (${statSync(source).size} bytes)`,
    `Scratch:     ${scratch}`,
    'A backup that has not been replayed is a hope. This replays it and reads it back.',
  ],
});

// A leftover scratch file from an earlier run would make the next replay collide
// on CREATE TABLE and report a good backup as broken.
rmSync(scratch, { recursive: true, force: true });

const replaySql = stripMigrationLedger(readFileSync(source, 'utf8'));

const order = orderedForDrop(replaySql);
if (typeof order === 'string') {
  process.stderr.write(`\nCannot read the schema in ${source}: ${order}\n`);
  process.exit(2);
}
if (order.length === 0) {
  process.stderr.write(
    `\nNo table definitions found in ${source}.\n` +
      'A file with no schema is not a backup of this database.\n',
  );
  process.exit(2);
}

let db: DatabaseSync;
try {
  db = new DatabaseSync(scratch);
  db.exec(replaySql);
} catch (thrown) {
  process.stderr.write(
    `\nReplay of ${source} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}\n\n` +
      'The backup has NOT been proved restorable. Do not migrate, deploy or treat\n' +
      'this file as a recovery point until the cause is understood.\n',
  );
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

try {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];

  const counts: Record<string, number | null> = {};
  for (const table of EVIDENCE_TABLES) {
    const present = tables.some((row) => row.name === table);
    counts[table] = present
      ? Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n)
      : null;
  }

  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;

  const missing = EVIDENCE_TABLES.filter((table) => counts[table] === null);

  process.stdout.write(`\nReplayed ${order.length} tables into the scratch database.\n\n`);
  for (const table of EVIDENCE_TABLES) {
    process.stdout.write(
      `  ${table.padEnd(24)} ${counts[table] === null ? 'MISSING' : String(counts[table])}\n`,
    );
  }
  process.stdout.write(
    `\nForeign key check: ${foreignKeyViolations.length === 0 ? 'clean' : `${foreignKeyViolations.length} violation(s)`}\n` +
      `Integrity check:   ${integrity?.integrity_check ?? 'unknown'}\n`,
  );

  if (missing.length > 0) {
    process.stderr.write(
      `\nFAILED: ${source} does not contain ${missing.join(', ')}.\n` +
        'A restore of this file would come back without them.\n',
    );
    process.exit(1);
  }
  if (foreignKeyViolations.length > 0) {
    process.stderr.write(`\nFAILED: ${source} replays with foreign keys unsatisfied.\n`);
    process.exit(1);
  }
  if (integrity?.integrity_check !== 'ok') {
    process.stderr.write(`\nFAILED: integrity_check said ${integrity?.integrity_check ?? 'nothing'}.\n`);
    process.exit(1);
  }

  process.stdout.write(
    `\n${source} is restorable: replayed, foreign keys clean, integrity ok.\n\n` +
      'What this does not prove: that the data is the *right* data. Compare the\n' +
      'counts above with the source database read-back recorded before the backup.\n',
  );
} finally {
  db.close();
  // The scratch copy is deleted: it holds a full copy of the data and has no
  // reason to outlive the check that produced it.
  rmSync(scratch, { recursive: true, force: true });
}
