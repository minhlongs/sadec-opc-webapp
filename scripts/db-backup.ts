#!/usr/bin/env node
/**
 * Exports a database to a file.
 *
 * §14 requires a backup to be actually exercised and restored, not merely
 * described in a README, so the restore command below is where this file gets
 * used in anger.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { bindingNameFor, printTarget, requireEnvironment } from './require-environment.ts';

const environment = requireEnvironment(process, 'db:backup');
const binding = bindingNameFor(environment);

// A single dated path, so a backup is never overwritten by the next one and a
// restore can point at a specific moment.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDirectory = 'backups';
const outputFile = `${outputDirectory}/${binding}-${stamp}.sql`;

mkdirSync(outputDirectory, { recursive: true });

const remote = environment === 'pilot' ? ['--remote'] : ['--local'];

printTarget(process, {
  command: 'db:backup',
  environment,
  database: binding,
  extra: [`Output:     ${outputFile}`, `Mode:       ${remote[0]}`],
});

const result = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'export', binding, ...remote, '--output', outputFile],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  process.stderr.write(
    `\nExport of ${binding} failed with exit status ${result.status}.\n` +
      'A backup that did not complete is not a backup; do not proceed to a\n' +
      'restore, a migration, or any destructive step on the strength of it.\n',
  );
  process.exit(result.status ?? 1);
}

process.stdout.write(`\nWrote ${outputFile}\n`);
