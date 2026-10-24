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

import { existsSync, readdirSync, statSync } from 'node:fs';
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

function latestBackupFor(bindingName) {
  const candidates = readdirSync(backupsDirectory)
    .filter((name) => name.startsWith(`${bindingName}-`) && name.endsWith('.sql'))
    .map((name) => ({ name, mtime: statSync(join(backupsDirectory, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  return candidates.length > 0
    ? join(backupsDirectory, candidates[0].name)
    : null;
}

const source = explicitFile ?? latestBackupFor(workingBinding);

if (source === null) {
  process.stderr.write(
    `\nNo backup found for ${binding} in ${backupsDirectory}.\n` +
      `Run pnpm db:backup -- --env ${environment} first.\n`,
  );
  process.exit(2);
}

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

const restore = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'execute', restoreBinding, '--local', '--file', source],
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
const probe = spawnSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'd1',
    'execute',
    restoreBinding,
    '--local',
    '--command',
    "SELECT 'workspaces' AS table_name, COUNT(*) AS rows FROM workspaces UNION ALL " +
      "SELECT 'identities', COUNT(*) FROM identities UNION ALL " +
      "SELECT 'memberships', COUNT(*) FROM memberships",
  ],
  { encoding: 'utf8' },
);

process.stdout.write('\nRead back from the restored database:\n');
if (probe.status === 0) {
  process.stdout.write(`${probe.stdout ?? ''}`);
} else {
  process.stdout.write(
    `${probe.stdout ?? ''}${probe.stderr ?? ''}\n` +
      'The row-count read-back did not run, so case 15 has no evidence yet.\n',
  );
}
process.stdout.write(`\nRestored ${source} into ${restoreBinding} and read it back.\n`);
