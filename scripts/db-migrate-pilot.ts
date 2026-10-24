#!/usr/bin/env node
/**
 * Applies migrations to the pilot database — the remote one.
 *
 * §14 asks that migration commands distinguish local from remote and refuse a
 * destructive migration on real data. This command is the remote half, so it is
 * separate from `db:migrate:local` by design: nothing that touches the pilot
 * database is reachable by a flag on the local command.
 *
 * The environment guard accepts only `pilot`.
 */

import { spawnSync } from 'node:child_process';
import { bindingNameFor, printTarget, requireEnvironment } from './require-environment.ts';

const environment = requireEnvironment(process, 'db:migrate-pilot');
const binding = bindingNameFor(environment);

printTarget(process, {
  command: 'db:migrate-pilot',
  environment,
  database: binding,
  extra: [
    'Mode:       --remote (this command is always remote)',
    'This is the private preview database. Confirm the name above is the pilot',
    'binding before continuing; a remote migration cannot be undone by rerunning.',
  ],
});

// Require an explicit confirmation, because a migration on the pilot database
// affects the environment a nursery owner may already be entering data into.
const confirmFlagIndex = process.argv.indexOf('--confirm');
const confirmation = confirmFlagIndex === -1 ? null : process.argv[confirmFlagIndex + 1];

if (confirmation !== binding) {
  process.stderr.write(
    `\nRefusing to migrate the pilot database without explicit confirmation.\n` +
      `Rerun as: pnpm db:migrate:pilot -- --env pilot --confirm ${binding}\n`,
  );
  process.exit(2);
}

const result = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'migrations', 'apply', binding, '--remote'],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  const output = String(result.status);
  process.stderr.write(
    `\nRemote migration against ${binding} failed with exit status ${output}.\n` +
      'Read the failing migration before trying again. A partially applied\n' +
      'migration on the pilot database is a real incident, not a retry.\n',
  );
  process.exit(result.status ?? 1);
}

process.stdout.write(`\nMigrations applied to ${binding} (remote).\n`);
