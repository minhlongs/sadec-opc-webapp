#!/usr/bin/env node
/**
 * Seeds the demo database, and only the demo database.
 *
 * §14 asks for the seed to be idempotent, so re-running it never overwrites an
 * edit made during a demo, and for a reset to be a separate command with a
 * guard rather than something a normal start-up does on its own.
 * §6 forbids a "turn demo into real" affordance, so this script touches nothing
 * but the demo database.
 */

import { spawnSync } from 'node:child_process';
import { bindingNameFor, printTarget, requireEnvironment } from './require-environment.ts';

const environment = requireEnvironment(process, 'db:seed:demo');
const binding = bindingNameFor(environment);

printTarget(process, {
  command: 'db:seed:demo',
  environment,
  database: binding,
  extra: [
    'Seed is idempotent: rerunning keeps any changes made during a demo.',
    'There is no command in this repo that turns demo data into real data.',
  ],
});

// The seed file is SQL, applied through wrangler so it runs against the same
// binding the app reads. It inserts only rows that are not already present,
// keyed on a stable external id.
const result = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'execute', binding, '--local', '--file', 'migrations/seed/demo.sql'],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  process.stderr.write(
    `\nDemo seed into ${binding} failed with exit status ${result.status}.\n` +
      'Read the failing statement before rerunning, and re-check the row counts\n' +
      'afterwards: an interrupted seed can leave some rows applied and others not.\n',
  );
  process.exit(result.status ?? 1);
}

process.stdout.write(`\nDemo seed applied to ${binding}.\n`);
