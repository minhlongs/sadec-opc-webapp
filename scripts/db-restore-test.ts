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
 *   3. After the restore, row counts are read back from the database rather
 *      than from the file, so the evidence is what actually landed. §15 case 15
 *      asks for a restore that can be read back, not a statement that one
 *      happened.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bindingNameFor, printTarget, requireEnvironment } from './require-environment.ts';

const environment = requireEnvironment(process, 'db:restore:test');
const binding = bindingNameFor(environment);

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
  return candidates.length > 0 ? join(backupsDirectory, candidates[0].name) : null;
}

const source = explicitFile ?? latestBackupFor(binding);

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
  database: binding,
  extra: [`Source:     ${source}`],
});

const restore = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'execute', binding, '--local', '--file', source],
  { stdio: 'inherit' },
);

if (restore.status !== 0) {
  process.stderr.write(
    `\nRestore into ${binding} failed with exit status ${restore.status}.\n` +
      'Do not treat the test database as clean until this succeeds.\n',
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
    binding,
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
process.stdout.write(`\nRestored ${source} into ${binding}.\n`);
