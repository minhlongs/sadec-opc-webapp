#!/usr/bin/env node
/**
 * Applies migrations to the local demo or test database.
 *
 * The environment is required, never inferred. §14 asks that the command name
 * its target and refuse when it is missing or the wrong kind, because a
 * migration applied to the wrong database is the mistake that cannot be undone
 * by running the command again.
 */

import { spawnSync } from 'node:child_process';
import {
  bindingNameFor,
  persistArguments,
  persistPathFromEnvironment,
  printTarget,
  requireEnvironment,
} from './require-environment.ts';

const environment = requireEnvironment(process, 'db:migrate:local');
const binding = bindingNameFor(environment);

const persist = persistPathFromEnvironment();
printTarget(process, {
  command: 'db:migrate:local',
  environment,
  database: binding,
  extra: [
    'Note: local development only. Never pass --remote from this command; a remote',
    'migration has its own command and its own target confirmation.',
    // Printed because the same binding name lives in more than one local
    // directory once the browser suite has its own.
    ...(persist === null
      ? ['Persist directory: the default (.wrangler/state).']
      : [`Persist directory: ${persist} (SADEC_D1_PERSIST).`]),
  ],
});

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    binding,
    '--local',
    ...persistArguments(),
  ],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  process.stderr.write(
    `\nMigration against ${binding} failed with exit status ${result.status}.\n` +
      'Check the migration file before running this again; a partially applied\n' +
      'migration is worse than one that clearly failed.\n',
  );
  process.exit(result.status ?? 1);
}

process.stdout.write(`\nMigrations applied to ${binding}.\n`);
