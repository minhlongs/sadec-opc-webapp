#!/usr/bin/env node
/**
 * Restores a backup into the test database, and reads it back.
 *
 * This is the most destructive command in the repo: a restore pointed at the
 * wrong database erases what it lands on. Three things protect against that,
 * and all three are deliberate:
 *
 *   1. The environment guard accepts only `test`. Naming demo or pilot is
 *      refused before anything runs. §17 requires no default path that can
 *      overwrite a real database, so there is no default at all.
 *
 *   2. The target is printed with its name before any work happens, per §14.
 *
 *   3. The restore lands in its own binding, not on top of the working test
 *      database. A backup taken by `wrangler d1 export` contains the schema and
 *      the migration ledger, so replaying it onto a database that already has
 *      those rows fails on the ledger's primary key. Restoring into a scratch
 *      binding proves the backup is complete without destroying the database the
 *      suite runs against.
 *
 *   4. After the restore, row counts are read back from the database rather
 *      than from the file, so the evidence is what actually landed. §15 case 15
 *      asks for a restore that can be read back, not a statement that one
 *      happened.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bindingNameFor, printTarget, requireEnvironment } from './require-environment.ts';

const environment = requireEnvironment(process, 'db:restore:test');

// The working test database, which the backup was taken from and which the suite
// runs against. It is reported so the operator knows what is being left alone.
const workingBinding = bindingNameFor(environment);

// A separate binding for the restore, so the working database survives. §14
// forbids a default path that could overwrite a real database; this is that rule
// applied to the closest call — the test database itself.
const restoreBinding = `${workingBinding}_restore`;

const backupsDirectory = 'backups';

if (!existsSync(backupsDirectory)) {
  process.stderr.write(
    `\nNo ${backupsDirectory} directory. Run pnpm db:backup -- --env ${environment} first.\n`,
  );
  process.exit(2);
}

// The newest backup for this binding, so the common case needs no argument.
// An explicit --file still overrides, for restoring an older moment.
const fileFlagIndex = process.argv.indexOf('--file');
const explicitFile = fileFlagIndex === -1 ? null : process.argv[fileFlagIndex + 1];

function latestBackupFor(bindingName: string): string | null {
  const candidates = readdirSync(backupsDirectory)
    .filter((name) => name.startsWith(`${bindingName}-`) && name.endsWith('.sql'))
    // A file this script wrote on a previous run is a replay, not a backup.
    // Including it would make the next restore wrap another replay around it.
    .filter((name) => !name.includes('.replay.'))
    .map((name) => ({ name, mtime: statSync(join(backupsDirectory, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  const newest = candidates[0];
  return newest === undefined ? null : join(backupsDirectory, newest.name);
}

const source = explicitFile ?? latestBackupFor(workingBinding);

if (source === null) {
  process.stderr.write(
    `\nNo backup found for ${workingBinding} in ${backupsDirectory}.\n` +
      `Run pnpm db:backup -- --env ${environment} first.\n`,
  );
  process.exit(2);
}

/**
 * Strips Wrangler's own bookkeeping from a backup so it can be replayed.
 *
 * `wrangler d1 export` writes the schema, the data, and two internal tables:
 * `d1_migrations`, which records which migration files have been applied, and
 * `sqlite_sequence`, which records that ledger's counter. Neither is business
 * data. Wrangler creates the ledger for a fresh binding before the file is
 * applied, so replaying these rows collides on the primary key and the restore
 * fails with a constraint error that says nothing about what actually went
 * wrong.
 *
 * A restore should reproduce the data, not re-enact the source machine's
 * migration history, so those statements are dropped here. The migration that
 * put the schema in place is history; the rows are the thing worth recovering.
 */
function stripMigrationLedger(sql: string): string {
  // Split on statement terminators so a multi-line CREATE is removed whole.
  const statements = sql
    .split(';\n')
    .map((statement) => statement.trim())
    .filter((statement) => {
      if (statement === '') return false;
      if (/^CREATE TABLE IF NOT EXISTS "d1_migrations"/.test(statement)) return false;
      if (/^INSERT INTO "d1_migrations"/.test(statement)) return false;
      // The sequence that counts the ledger is emitted as three parts: the reset,
      // the row for the ledger's counter, and — critically — a bare
      // `DELETE FROM sqlite_sequence` wrangler writes to clear the table before
      // reinserting. Dropping the INSERTs alone leaves that DELETE, and since the
      // ledger it belongs to is gone, SQLite never creates `sqlite_sequence` in the
      // replayed database: the restore then dies on "no such table:
      // sqlite_sequence" and reports a restorable backup as broken.
      if (/^DELETE FROM "?sqlite_sequence"?\b/i.test(statement)) return false;
      if (/^INSERT INTO "sqlite_sequence"/.test(statement)) return false;
      return true;
    });
  return `${statements.map((s) => `${s};\n`).join('')}`;
}

// The replay file lives beside the backup, so the original export stays exactly
// as it was taken and can still be read back as the artefact that was produced.
const replayFile = `${source}.replay.sql`;
const replaySql = stripMigrationLedger(readFileSync(source, 'utf8'));
writeFileSync(replayFile, replaySql);

printTarget(process, {
  command: 'db:restore:test',
  environment,
  database: restoreBinding,
  extra: [
    `Source:      ${source}`,
    `Left alone:  ${workingBinding} (the working test database the suite runs against)`,
    'The restore lands in its own binding, so this proves the backup is complete',
    'without overwriting the database the test suite depends on.',
  ],
});

/**
 * Every table the replay creates, in an order that can be dropped safely.
 *
 * A child table references its parent, so a DROP that reaches the parent first
 * is refused by the foreign key — which is indistinguishable, from the outside,
 * from a broken backup. Children therefore go first.
 *
 * The order is read from the replay's own REFERENCES edges rather than written
 * out here or sorted: a table added to a migration but missing from a hand-kept
 * list silently survives the reset, the next run's CREATE TABLE collides, and a
 * restorable backup is reported as broken. Sorting by name is not enough either
 * — `workspaces` sorts after `quote_drafts` alphabetically, yet `quote_drafts`
 * references it.
 *
 * A cycle (or a reference to a table the replay does not create) is not an
 * order this can compute, so it is reported rather than guessed at.
 */
function orderedForDrop(replaySql: string): string[] | string {
  const statements = [...replaySql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?(\w+)[^;]*;/gi)];

  const tables = new Set<string>();
  // parent → children, read straight off the REFERENCES edges. A table may only
  // be dropped once every table still standing has stopped referencing it.
  const referencedBy = new Map<string, string[]>();

  for (const match of statements) {
    const table = match[1];
    const body = match[0];
    if (table === undefined || body === undefined) continue;
    tables.add(table);

    for (const reference of body.matchAll(/REFERENCES\s+["`]?(\w+)/gi)) {
      const parent = reference[1];
      if (parent === undefined || parent === table) continue;
      referencedBy.set(parent, [...(referencedBy.get(parent) ?? []), table]);
    }
  }

  const ordered: string[] = [];
  const placed = new Set<string>();

  // Drop from the leaves inward: anything no unplaced table references is safe
  // next, because nothing standing can refuse the drop.
  while (ordered.length < tables.size) {
    const ready = [...tables]
      .filter((table) => !placed.has(table))
      .filter((table) => (referencedBy.get(table) ?? []).every((child) => placed.has(child)));

    if (ready.length === 0) {
      return `The replay references tables in a cycle: ${[...tables].filter((t) => !placed.has(t)).join(', ')}`;
    }
    for (const table of ready) {
      ordered.push(table);
      placed.add(table);
    }
  }

  return ordered;
}

// Empty the scratch binding first. The backup's schema uses CREATE TABLE, and a
// leftover table from an earlier run makes every one of those collide — a failure
// that says nothing about the backup. So the scratch binding is cleared before
// the replay runs.
const tablesToDrop = orderedForDrop(replaySql);

if (typeof tablesToDrop === 'string') {
  process.stderr.write(`\nCannot clear ${restoreBinding} safely: ${tablesToDrop}\n`);
  process.exit(2);
}

if (tablesToDrop.length === 0) {
  process.stderr.write(
    `\nNo table definitions found in ${replayFile}.\n` +
      'A replay with no schema cannot be restored, and restoring nothing would\n' +
      'report an empty success.\n',
  );
  process.exit(2);
}

const tablesInReplay = tablesToDrop;

const reset = spawnSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'd1',
    'execute',
    restoreBinding,
    '--local',
    '--command',
    tablesInReplay.map((table) => `DROP TABLE IF EXISTS "${table}";`).join(' '),
  ],
  { stdio: 'inherit' },
);

if (tablesInReplay.length === 0) {
  process.stderr.write(
    `\nNo table definitions found in ${replayFile}.\n` +
      'A replay with no schema cannot be restored, and restoring nothing would\n' +
      'report an empty success.\n',
  );
  process.exit(2);
}

if (reset.status !== 0) {
  process.stderr.write(
    `\nCould not clear ${restoreBinding} before restoring, exit status ${reset.status}.\n` +
      'The scratch database is the only one this command writes to, so refusing\n' +
      'here is safe — but the restore has not been proved.\n',
  );
  process.exit(reset.status ?? 1);
}

const restore = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'execute', restoreBinding, '--local', '--file', replayFile],
  { stdio: 'inherit' },
);

if (restore.status !== 0) {
  process.stderr.write(
    `\nRestore of ${source} into ${restoreBinding} failed with exit status ${restore.status}.\n` +
      'The backup has not been proved restorable. Do not treat it as a recovery\n' +
      'path, and take a fresh backup before any destructive step.\n',
  );
  process.exit(restore.status ?? 1);
}

// Read the restored database back. A row count from the file proves nothing
// about what landed, so these come from a query.
//
// The evidence lives in ten tables, and they are counted as ten scalar
// sub-selects rather than ten UNION ALL terms on purpose: the SQLite the local
// D1 runtime is built on refuses more than five compound terms with
// "too many terms in compound SELECT". A rehearsal on 2026-10-30 hit exactly
// that — the restore succeeded, the read-back did not run, and the script still
// exited 0. Widening a UNION list is how that trap is entered, so the shape of
// the query avoids it and a failed read-back below is an error rather than a
// footnote.
const evidenceTables = [
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
];

const probeSql = `SELECT ${evidenceTables
  .map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`)
  .join(', ')}`;

const probe = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'execute', restoreBinding, '--local', '--command', probeSql],
  { encoding: 'utf8' },
);

process.stdout.write('\nRead back from the restored database:\n');
if (probe.status === 0) {
  process.stdout.write(`${probe.stdout ?? ''}`);
} else {
  process.stdout.write(
    `${probe.stdout ?? ''}${probe.stderr ?? ''}\n` +
      'The row-count read-back did not run, so this restore has no evidence.\n',
  );
  process.exit(probe.status ?? 1);
}
process.stdout.write(`\nRestored ${source} into ${restoreBinding} and read it back.\n`);
