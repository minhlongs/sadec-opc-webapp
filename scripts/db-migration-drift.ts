#!/usr/bin/env node
/**
 * Refuses to let a migration run against a ledger this tree cannot explain.
 *
 *   pnpm exec wrangler d1 execute sadec_pilot --remote --json \
 *     --command "SELECT name FROM d1_migrations ORDER BY id" > /tmp/ledger.json
 *   pnpm db:migration-drift -- --ledger /tmp/ledger.json
 *
 * Read-only: it reads the file above and `migrations/*.sql`, and touches no
 * database. That is why it has no `--env` guard — it cannot write, so naming a
 * target would only imply it had. The command that actually migrates
 * (`db:migrate-pilot`) keeps its guard and its `--confirm`.
 *
 * Exit codes: 2 when called wrongly, 1 on a conflict or an unreadable ledger, 0
 * when the ledger describes this tree. "Nothing pending" is a pass.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { compareLedger, describeLedger, parseLedgerRows } from './migration-ledger.ts';

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value.trim();
}

const ledgerPath = flagValue('--ledger');
const directory = flagValue('--dir') ?? 'migrations';

if (ledgerPath === null) {
  process.stderr.write(
    '\nError: db:migration-drift requires --ledger <file>.\n\n' +
      'Produce it with:\n' +
      '  pnpm exec wrangler d1 execute sadec_pilot --remote --json \\\n' +
      '    --command "SELECT name FROM d1_migrations ORDER BY id" > /tmp/ledger.json\n\n' +
      'There is no default: reading the newest file in a directory would let the\n' +
      'check compare a ledger with itself.\n',
  );
  process.exit(2);
}

let localFiles: string[];
try {
  localFiles = readdirSync(directory).filter((name) => name.endsWith('.sql'));
} catch (error) {
  process.stderr.write(`\nError: cannot read ${directory}/: ${String(error)}\n`);
  process.exit(2);
}

if (localFiles.length === 0) {
  process.stderr.write(`\nError: ${directory}/ holds no .sql files, so this check would prove nothing.\n`);
  process.exit(1);
}

let applied: string[];
try {
  applied = parseLedgerRows(readFileSync(ledgerPath, 'utf8'));
} catch (error) {
  process.stderr.write(
    `\nError: the ledger at ${ledgerPath} could not be read as a migration ledger.\n` +
      `${error instanceof Error ? error.message : String(error)}\n\n` +
      'An unreadable ledger is a refusal, not an empty one: treating it as empty\n' +
      'would report every migration as pending.\n',
  );
  process.exit(1);
}

const comparison = compareLedger(localFiles, applied);
for (const line of describeLedger(comparison)) {
  process.stdout.write(`${line}\n`);
}

if (comparison.unknownApplied.length > 0) {
  process.exit(1);
}

process.stdout.write('\nLedger and tree agree.\n');
