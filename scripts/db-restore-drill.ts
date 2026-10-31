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
 *     keeps its foreign keys satisfied and its integrity intact, still holds the
 *     rows the evidence depends on, and **carries the migration ledger the
 *     snapshot was taken at**.
 *
 * The replay is of the whole export, migration ledger included. That is
 * deliberate and it is what makes the report useful: the rebuilt database is the
 * snapshot, so the ledger names in the report are read **out of the recovered
 * database** rather than from the live one. A ledger read from the live database
 * after the export describes the database as it is now, not the one that was
 * exported, and a fingerprint of it would be a fingerprint of the wrong thing.
 *
 * What this is not: a remote D1 restore. Nothing is restored into a Cloudflare
 * database, and no statement here has touched the pilot. It is a local replay of
 * a file, which is why `docs/OPERATIONS-PILOT.md` never calls it that.
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

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fingerprintLedger, sha256Hex } from './backup-receipt-rules.ts';
import { bindingNameFor, printTarget, requireEnvironment } from './require-environment.ts';
import { orderedForDrop } from './restore-sql.ts';

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

// Which copy of the backup this is. `bucket-readback` is the file downloaded back
// out of the bucket, which is the only one that tests the object a restore would
// use; anything else — including no flag at all — is recorded as the local copy,
// because the conservative label is the one that cannot flatter the backup.
const drilledFromFlag = flagValue('--drilled-from');
if (drilledFromFlag !== null && drilledFromFlag !== 'bucket-readback' && drilledFromFlag !== 'exported-file') {
  process.stderr.write(
    `\nError: --drilled-from must be "bucket-readback" or "exported-file", got "${drilledFromFlag}".\n`,
  );
  process.exit(2);
}
const drilledFrom: 'bucket-readback' | 'exported-file' =
  drilledFromFlag === 'bucket-readback' ? 'bucket-readback' : 'exported-file';
// Optional machine-readable verdict, so a backup job can record the drill in a
// receipt instead of transcribing it from a log. It holds table names, counters
// and the integrity verdict — never a row.
const reportPath = flagValue('--report');

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

/**
 * The machine-readable verdict.
 *
 * It holds table names, counters, hashes and the integrity verdict — never a row.
 * `contentDigest` is a hash over the evidence tables' contents in a stated order,
 * so the same snapshot restored later can be shown to hold the same rows without
 * any of those rows being written down here.
 */
interface DrillReport {
  reportVersion: number;
  passed: boolean;
  tablesReplayed: number;
  missingTables: string[];
  foreignKeyViolations: number;
  integrity: string;
  ledger: string[];
  ledgerFingerprint: string;
  ledgerSource: string;
  evidence: { table: string; rows: number; digest: string }[];
  contentDigest: string;
  chainChecks: { name: string; orphans: number }[];
  empty: boolean;
  replay: string;
  drilledFrom: 'bucket-readback' | 'exported-file';
  note: string;
}

const REPORT_NOTE =
  'A local replay of an exported file into a scratch SQLite database. Not a remote ' +
  'D1 restore, and not a claim that the snapshot holds every row written after it.';

function writeReport(report: DrillReport): void {
  if (reportPath === null) return;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}

/** A deterministic digest over one table's rows, in a stated order. */
function tableDigest(db: DatabaseSync, table: string): { rows: number; digest: string } {
  // `rowid` is the order the rows were written, and every table in this schema is
  // an ordinary rowid table (no WITHOUT ROWID anywhere), so the order is stable for
  // the same file. A table that ever became WITHOUT ROWID would throw here rather
  // than hash an arbitrary order.
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[];
  const canonical = rows
    .map((row) =>
      Object.keys(row)
        .sort()
        .map((column) => `${column}=${JSON.stringify(row[column] ?? null)}`)
        .join('\u001f'),
    )
    .join('\u001e');
  return { rows: rows.length, digest: sha256Hex(`${table}\u001f${canonical}`) };
}

/**
 * Joins across the chain a restore has to preserve, counting rows whose parent is
 * absent. A foreign-key check can pass while the data that matters is unreachable;
 * these answer "is the quote → order → receipt chain still joined after a replay".
 *
 * Only the ones whose tables are all present are run, and a missing table is
 * already a failure, so they never mask each other.
 */
const CHAIN_CHECKS: { name: string; sql: string; tables: string[] }[] = [
  {
    name: 'orders → workspaces',
    tables: ['orders', 'workspaces'],
    sql: 'SELECT COUNT(*) AS n FROM orders c LEFT JOIN workspaces p ON p.id = c.workspace_id WHERE p.id IS NULL',
  },
  {
    name: 'orders → customers',
    tables: ['orders', 'customers'],
    sql: 'SELECT COUNT(*) AS n FROM orders c LEFT JOIN customers p ON p.id = c.customer_id WHERE p.id IS NULL',
  },
  {
    name: 'orders → accepted quote revision',
    tables: ['orders', 'quote_revisions'],
    sql: 'SELECT COUNT(*) AS n FROM orders c LEFT JOIN quote_revisions p ON p.id = c.accepted_revision_id WHERE p.id IS NULL',
  },
  {
    name: 'receipts → orders',
    tables: ['receipts', 'orders'],
    sql: 'SELECT COUNT(*) AS n FROM receipts c LEFT JOIN orders p ON p.id = c.order_id WHERE p.id IS NULL',
  },
  {
    name: 'receipt_events → receipts',
    tables: ['receipt_events', 'receipts'],
    sql: 'SELECT COUNT(*) AS n FROM receipt_events c LEFT JOIN receipts p ON p.id = c.receipt_id WHERE p.id IS NULL',
  },
  {
    name: 'memberships → identities',
    tables: ['memberships', 'identities'],
    sql: 'SELECT COUNT(*) AS n FROM memberships c LEFT JOIN identities p ON p.id = c.identity_id WHERE p.id IS NULL',
  },
  {
    name: 'memberships → workspaces',
    tables: ['memberships', 'workspaces'],
    sql: 'SELECT COUNT(*) AS n FROM memberships c LEFT JOIN workspaces p ON p.id = c.workspace_id WHERE p.id IS NULL',
  },
  {
    name: 'escrow entries → b2b bookings',
    tables: ['escrow_ledger_entries', 'b2b_bookings'],
    sql: 'SELECT COUNT(*) AS n FROM escrow_ledger_entries c LEFT JOIN b2b_bookings p ON p.id = c.booking_id WHERE p.id IS NULL',
  },
  {
    name: 'audit events → workspaces (when set)',
    tables: ['audit_events', 'workspaces'],
    sql: 'SELECT COUNT(*) AS n FROM audit_events c LEFT JOIN workspaces p ON p.id = c.workspace_id WHERE c.workspace_id IS NOT NULL AND p.id IS NULL',
  },
  {
    name: 'config versions → workspaces (when set)',
    tables: ['config_versions', 'workspaces'],
    sql: 'SELECT COUNT(*) AS n FROM config_versions c LEFT JOIN workspaces p ON p.id = c.workspace_id WHERE c.workspace_id IS NOT NULL AND p.id IS NULL',
  },
];

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

// The whole export, ledger included. `stripMigrationLedger` exists for restoring
// *into* a database that already has a ledger; this scratch file is empty, so
// replaying the ledger is safe and gives the report the snapshot's own history.
const replaySql = readFileSync(source, 'utf8');

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
  writeReport({
    reportVersion: 1,
    passed: false,
    tablesReplayed: 0,
    missingTables: [],
    foreignKeyViolations: -1,
    integrity: `replay failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    ledger: [],
    ledgerFingerprint: '',
    ledgerSource: 'restored-database (unavailable: the replay failed)',
    evidence: [],
    contentDigest: '',
    chainChecks: [],
    empty: true,
    replay: 'full export, including the migration ledger',
    drilledFrom,
    note: REPORT_NOTE,
  });
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

  // The snapshot's own history, read out of the database this replay produced.
  const ledger = (
    db.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as { name: string }[]
  ).map((row) => String(row.name));
  const ledgerFingerprint = ledger.length === 0 ? '' : fingerprintLedger(ledger);

  const evidence = order
    .filter((table) => table !== 'sqlite_sequence')
    .map((table) => ({ table, ...tableDigest(db, table) }));
  const contentDigest = sha256Hex(
    evidence.map((entry) => `${entry.table}\u001f${entry.rows}\u001f${entry.digest}`).join('\u001e'),
  );

  const present = new Set(order);
  const chainChecks = CHAIN_CHECKS.filter((check) => check.tables.every((table) => present.has(table))).map(
    (check) => {
      const row = db.prepare(check.sql).get() as { n: number } | undefined;
      return { name: check.name, orphans: Number(row?.n ?? -1) };
    },
  );
  const brokenChains = chainChecks.filter((check) => check.orphans !== 0);
  const empty = EVIDENCE_TABLES.every((table) => (counts[table] ?? 0) === 0);

  process.stdout.write(`\nReplayed ${order.length} tables into the scratch database.\n\n`);
  for (const table of EVIDENCE_TABLES) {
    const row = evidence.find((entry) => entry.table === table);
    process.stdout.write(
      `  ${table.padEnd(24)} ${counts[table] === null ? 'MISSING' : String(counts[table])}` +
        `${row === undefined ? '' : `  digest ${row.digest.slice(0, 12)}`}\n`,
    );
  }
  process.stdout.write(
    `\nForeign key check: ${foreignKeyViolations.length === 0 ? 'clean' : `${foreignKeyViolations.length} violation(s)`}\n` +
      `Integrity check:   ${integrity?.integrity_check ?? 'unknown'}\n` +
      `Snapshot ledger:   ${ledger.length === 0 ? 'EMPTY' : `${ledger.length} migration(s), ${ledger[ledger.length - 1]}`} ` +
      '(read from the restored copy)\n' +
      `Content digest:    ${contentDigest.slice(0, 16) || '(none)'}\n` +
      `Drilled from:      ${drilledFrom}\n` +
      `Data:              ${empty ? 'every evidence table replayed empty (this snapshot holds no records)' : 'evidence tables hold rows'}\n`,
  );
  for (const check of chainChecks) {
    process.stdout.write(`  chain ${check.name.padEnd(40)} ${check.orphans} orphan(s)\n`);
  }

  const verdict: DrillReport = {
    reportVersion: 1,
    passed:
      missing.length === 0 &&
      foreignKeyViolations.length === 0 &&
      integrity?.integrity_check === 'ok' &&
      ledger.length > 0 &&
      brokenChains.length === 0,
    tablesReplayed: order.length,
    missingTables: missing,
    foreignKeyViolations: foreignKeyViolations.length,
    integrity: integrity?.integrity_check ?? 'unknown',
    ledger,
    ledgerFingerprint,
    ledgerSource: 'restored-database',
    evidence,
    contentDigest,
    chainChecks,
    empty,
    replay: 'full export, including the migration ledger',
    drilledFrom,
    note: REPORT_NOTE,
  };
  writeReport(verdict);

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
  if (ledger.length === 0) {
    process.stderr.write(
      `\nFAILED: ${source} records no applied migrations.\n` +
        'Without a ledger in the snapshot there is no schema fingerprint to compare a\n' +
        'later migration against, so this cannot be the evidence a migration needs.\n',
    );
    process.exit(1);
  }
  if (brokenChains.length > 0) {
    process.stderr.write(
      `\nFAILED: the replayed data has ${brokenChains.length} broken chain(s): ` +
        `${brokenChains.map((check) => `${check.name} (${check.orphans} orphan rows)`).join('; ')}.\n`,
    );
    process.exit(1);
  }

  if (reportPath !== null) process.stdout.write(`Verdict written to ${reportPath}\n`);

  process.stdout.write(
    `\n${source} is restorable: replayed, foreign keys clean, integrity ok, chains joined,\n` +
      'and the snapshot ledger was read back from the restored copy.\n\n' +
      'What this does not prove: that the snapshot holds every row the live database had\n' +
      'when it was taken, or every row written after it. Compare it with the live data\n' +
      'deliberately, not as an equality test: the live database keeps changing, and a\n' +
      'difference is not by itself a broken backup.\n',
  );
} finally {
  db.close();
  // The scratch copy is deleted: it holds a full copy of the data and has no
  // reason to outlive the check that produced it.
  rmSync(scratch, { recursive: true, force: true });
}
