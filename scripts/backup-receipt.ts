#!/usr/bin/env node
/**
 * Writes a backup receipt, or checks one before an irreversible migration.
 *
 *   pnpm backup:receipt -- target --env pilot
 *   pnpm backup:receipt -- key --env pilot --database-id <uuid> \
 *       --exported-at <iso> --run-id <id> --run-attempt <n>
 *   pnpm backup:receipt -- create --env pilot --file <export> ... --out <receipt.json>
 *   pnpm backup:receipt -- verify --env pilot --receipt <receipt.json> \
 *       --account-id … --database-id … --database-name … \
 *       --ledger <live-ledger.json> --observed-sha256 … --observed-bytes …
 *
 * The subcommand is the first argument that is not a flag, so both
 * `pnpm backup:receipt create …` and `pnpm backup:receipt -- create …` work. The
 * second form is what an operator naturally types, and before this was handled the
 * CLI read `--` as the subcommand and refused with a usage error — a bug that made
 * every documented invocation fail.
 *
 * Two subcommands, because the two moments are different: `create` runs once at
 * the end of a backup job when every part of the drill has already succeeded;
 * `verify` runs at the start of a migration and must be able to refuse.
 *
 * What `verify` will not accept, each for a reason a test covers:
 *
 *   - a receipt naming another account, database or environment;
 *   - a receipt whose read-back hash differs from the exported hash;
 *   - a receipt whose drill did not pass (or lost a table, or left foreign keys
 *     broken, or failed integrity);
 *   - a receipt whose snapshot ledger is not the ledger the database reports
 *     **right now** (the run reads it with `wrangler d1 execute` and passes it as
 *     `--ledger`; the tree's own files are compared separately by
 *     `db:migration-drift`, because during a migration the tree legitimately holds
 *     migrations that are not applied yet);
 *   - a receipt older than the configured limit;
 *   - an object that is not what the receipt says: `--observed-sha256` and
 *     `--observed-bytes` are its own read of the stored object, and the workflow
 *     computes them by downloading the object again. A receipt is a claim; the
 *     read-back is the check.
 *
 * The operator never supplies an object key and a run id and calls that evidence.
 * The key comes from the receipt, and the receipt only exists if the backup job
 * wrote it after its own drill passed.
 */

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_MAX_BACKUP_AGE_HOURS,
  RECEIPT_VERSION,
  backupObjectKey,
  backupPrefix,
  evaluateReceipt,
  fingerprintLedger,
  sha256Hex,
  validateReceiptShape,
  type BackupReceipt,
  type BackupTarget,
  type RestoreDrillResult,
} from './backup-receipt-rules.ts';
import { parseLedgerRows } from './migration-ledger.ts';
import { databaseIdFor } from './preflight-facts.ts';

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value.trim();
}

function usage(problems: string[]): never {
  process.stderr.write(
    `\nError: ${problems.join('\n       ')}\n\n` +
      'Usage:\n' +
      '  pnpm backup:receipt -- create --env <demo|test|pilot> --file <export.sql> \\\n' +
      '    --account-id <id> --database-id <uuid> --database-name <name> \\\n' +
      '    --bucket <name> --key <object key> --read-back-sha256 <hex> \\\n' +
      '    --drill-report <drill.json> --run-id <id> --run-attempt <n> \\\n' +
      '    --commit-sha <40-hex> --export-started-at <iso> --export-finished-at <iso> \\\n' +
      '    --uploaded-at <iso> --read-back-at <iso> \\\n' +
      '    --drill-started-at <iso> --drill-finished-at <iso> \\\n' +
      '    --out <receipt.json>\n\n' +
      '  pnpm backup:receipt -- verify --env <demo|test|pilot> --receipt <receipt.json> \\\n' +
      '    --account-id <id> --database-id <uuid> --database-name <name> \\\n' +
      '    --ledger <wrangler.json> --observed-sha256 <hex> --observed-bytes <n> \\\n' +
      '    [--max-age-hours <n>]\n',
  );
  process.exit(2);
}

function requireFlags(names: readonly string[]): void {
  const missing = names.filter((name) => flagValue(name) === null);
  if (missing.length > 0) usage([`missing ${missing.join(', ')}`]);
}

function readLedger(path: string): string[] {
  try {
    return parseLedgerRows(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `\nError: ${path} could not be read as a migration ledger: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        'An unreadable ledger is a refusal: a receipt that records no schema is not\n' +
        'evidence that the schema matches.\n',
    );
    process.exit(1);
  }
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `\nError: ${what} at ${path} could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

function targetFromFlags(): BackupTarget {
  return {
    accountId: flagValue('--account-id') ?? '',
    databaseId: flagValue('--database-id') ?? '',
    databaseName: flagValue('--database-name') ?? '',
    environment: flagValue('--env') ?? '',
  };
}

// The package runner forwards a literal `--` to the script when the operator writes
// `backup:receipt -- create ...`, and flags may precede the subcommand. The first
// argument that is neither a flag nor a separator is the subcommand.
const command = process.argv.slice(2).find((argument) => !argument.startsWith('-'));

if (command === 'target') {
  requireFlags(['--env']);
  // The database identity comes from `wrangler.jsonc`, not from a second copy in a
  // workflow: a literal there would drift from the binding the deploy uses, and the
  // receipt's whole job is to name the same database the deploy does.
  const environment = flagValue('--env') as string;
  const binding = `sadec_${environment}`;
  const id = databaseIdFor(readFileSync('wrangler.jsonc', 'utf8'), binding);
  if (id === null) {
    process.stderr.write(`\nError: wrangler.jsonc declares no database_id for ${binding}.\n`);
    process.exit(1);
  }
  process.stdout.write(`database-id=${id}\ndatabase-name=sadec-${environment}\n`);
  process.exit(0);
}

if (command === 'key') {
  requireFlags(['--env', '--database-id', '--exported-at', '--run-id', '--run-attempt']);
  // One function decides the key, so the object the job uploads and the key the
  // receipt records cannot drift apart.
  process.stdout.write(
    backupObjectKey({
      environment: flagValue('--env') as string,
      databaseId: flagValue('--database-id') as string,
      exportedAt: flagValue('--exported-at') as string,
      runId: flagValue('--run-id') as string,
      runAttempt: flagValue('--run-attempt') as string,
    }) + '\n',
  );
  process.exit(0);
}

if (command === 'create') {
  requireFlags([
    '--env',
    '--file',
    '--account-id',
    '--database-id',
    '--database-name',
    '--bucket',
    '--key',
    '--read-back-sha256',
    '--drill-report',
    '--run-id',
    '--run-attempt',
    '--commit-sha',
    '--export-started-at',
    '--export-finished-at',
    '--uploaded-at',
    '--read-back-at',
    '--drill-started-at',
    '--drill-finished-at',
    '--out',
  ]);

  const file = flagValue('--file') as string;
  if (!existsSync(file)) {
    process.stderr.write(`\nError: no export at ${file}. Nothing to record.\n`);
    process.exit(2);
  }
  const bytes = statSync(file).size;
  const sha256 = sha256Hex(readFileSync(file));

  const drill = readJson(flagValue('--drill-report') as string, 'the drill report');

  const drillRecord = drill as Partial<RestoreDrillResult> & Record<string, unknown>;
  const restore: RestoreDrillResult = {
    passed: drillRecord.passed === true,
    tablesReplayed: Number(drillRecord.tablesReplayed ?? 0),
    missingTables: Array.isArray(drillRecord.missingTables)
      ? (drillRecord.missingTables as string[])
      : ['(the drill report carried no missingTables field)'],
    foreignKeyViolations: Number(drillRecord.foreignKeyViolations ?? -1),
    integrity: String(drillRecord.integrity ?? '(missing)'),
    chainChecks: Array.isArray(drillRecord.chainChecks)
      ? (drillRecord.chainChecks as { name: string; orphans: number }[])
      : [{ name: '(the drill report carried no chain checks)', orphans: -1 }],
    contentDigest: String(drillRecord.contentDigest ?? ''),
    empty: drillRecord.empty === true,
    drilledFrom: drillRecord.drilledFrom === 'bucket-readback' ? 'bucket-readback' : 'exported-file',
  };

  // The ledger comes from the drill report, which read it out of the **restored
  // copy** of this export. It is not read from the live database here: a live read
  // taken after the export describes a database that may have moved on, and a
  // fingerprint of it would be the fingerprint of the wrong snapshot.
  const ledger = Array.isArray(drillRecord.ledger)
    ? (drillRecord.ledger as unknown[]).map((name) => String(name))
    : [];
  if (ledger.length === 0) {
    process.stderr.write(
      `\nRefusing to write a receipt: ${flagValue('--drill-report')} carries no ledger.\n` +
        'The ledger must be read back from the restored copy of the export; without it\n' +
        'there is nothing to compare a later migration against.\n',
    );
    process.exit(1);
  }
  const ledgerFingerprint = fingerprintLedger(ledger);
  if (
    typeof drillRecord.ledgerFingerprint === 'string' &&
    drillRecord.ledgerFingerprint !== '' &&
    drillRecord.ledgerFingerprint !== ledgerFingerprint
  ) {
    process.stderr.write(
      `\nRefusing to write a receipt: the drill report's ledger fingerprint ` +
        `(${drillRecord.ledgerFingerprint}) is not the fingerprint of the ledger it lists ` +
        `(${ledgerFingerprint}).\n`,
    );
    process.exit(1);
  }

  const target = targetFromFlags();
  const exportFinishedAt = flagValue('--export-finished-at') as string;
  const runId = flagValue('--run-id') as string;
  const runAttempt = flagValue('--run-attempt') as string;
  const bucket = flagValue('--bucket') as string;
  // The caller names the key it uploaded to, and this recomputes it from the same
  // inputs. If the two disagree, the receipt would describe an object nobody wrote,
  // so a mismatch is a refusal rather than a quiet correction.
  const derivedKey = backupObjectKey({
    environment: target.environment,
    databaseId: target.databaseId,
    exportedAt: exportFinishedAt,
    runId,
    runAttempt,
  });
  const key = flagValue('--key') as string;
  if (key !== derivedKey) {
    process.stderr.write(
      `\nRefusing to write a receipt: --key is "${key}", but this environment, database, ` +
        `timestamp, run and attempt derive "${derivedKey}".\n` +
        'The receipt would name an object the job did not write.\n',
    );
    process.exit(1);
  }
  if (!key.startsWith(backupPrefix(target.environment))) {
    process.stderr.write(
      `\nRefusing to write a receipt: ${key} is not under ` +
        `${backupPrefix(target.environment)}, where the retention and lock rules apply.\n`,
    );
    process.exit(1);
  }

  const receipt: BackupReceipt = {
    version: RECEIPT_VERSION,
    target,
    object: {
      bucket,
      key,
      bytes,
      sha256,
      readBackSha256: (flagValue('--read-back-sha256') as string).toLowerCase(),
      // The upload's own timestamp, not the read-back's. They are minutes apart on a
      // slow bucket and the difference is the window in which the object existed but
      // had not been verified.
      uploadedAt: flagValue('--uploaded-at') as string,
      prefix: backupPrefix(target.environment),
    },
    source: { runId, runAttempt, commitSha: (flagValue('--commit-sha') as string).toLowerCase() },
    timeline: {
      exportStartedAt: flagValue('--export-started-at') as string,
      exportFinishedAt,
      readBackAt: flagValue('--read-back-at') as string,
      drillStartedAt: flagValue('--drill-started-at') as string,
      drillFinishedAt: flagValue('--drill-finished-at') as string,
    },
    ledger,
    ledgerFingerprint,
    ledgerSource: 'restored-database',
    restore,
  };

  const problems = validateReceiptShape(receipt);
  if (problems.length > 0) {
    process.stderr.write(
      `\nRefusing to write a receipt that does not describe a usable backup:\n` +
        problems.map((problem: string) => `  - ${problem}\n`).join(''),
    );
    process.exit(1);
  }

  // The receipt is written by the backup job only after the drill has run, and it
  // records the drill's verdict rather than assuming it. A failed drill produces a
  // receipt that `verify` will refuse — deliberately, so the failure is visible in
  // the artefact rather than only in a log line.
  writeFileSync(flagValue('--out') as string, JSON.stringify(receipt, null, 2) + '\n');

  process.stdout.write(
    `Receipt written to ${flagValue('--out')}\n` +
      `  Target:      ${target.environment} / ${target.databaseName} / ${target.databaseId}\n` +
      `  Object:      ${bucket}/${key}\n` +
      `  Bytes:       ${bytes}\n` +
      `  SHA-256:     ${sha256}\n` +
      `  Ledger:      ${ledger.length} migration(s), fingerprint ${receipt.ledgerFingerprint}\n` +
      '               (read back from the restored copy, not from the live database)\n' +
      `  Timeline:    export ${receipt.timeline.exportStartedAt} → ` +
      `${receipt.timeline.exportFinishedAt}, drill finished ${receipt.timeline.drillFinishedAt}\n` +
      `  Drilled:     ${restore.drilledFrom}\n` +
      `  Drill:       ${restore.passed ? 'passed' : 'DID NOT PASS'}, ` +
      `${restore.tablesReplayed} table(s), ` +
      `${restore.foreignKeyViolations} foreign key violation(s), integrity ${restore.integrity}\n` +
      '\nNo customer data is in this file: identifiers, a size, hashes and verdicts only.\n',
  );

  if (!restore.passed) {
    process.stderr.write(
      '\nThe drill did not pass. The receipt records that, and a migration will refuse\n' +
        'it. This is not a backup to migrate on.\n',
    );
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'verify') {
  requireFlags([
    '--env',
    '--receipt',
    '--account-id',
    '--database-id',
    '--database-name',
    '--ledger',
    '--observed-sha256',
    '--observed-bytes',
  ]);

  const receiptPath = flagValue('--receipt') as string;
  const receipt = readJson(receiptPath, 'the receipt');
  const ledger = readLedger(flagValue('--ledger') as string);

  const configuredRaw = flagValue('--max-age-hours') ?? process.env.SADEC_MAX_BACKUP_AGE_HOURS ?? null;
  let configuredMaxAgeHours: number | null = null;
  if (configuredRaw !== null) {
    const parsed = Number(configuredRaw);
    // A threshold that cannot be read is a refusal, not a silent default: the
    // default would be a number nobody chose, guarding the wrong window.
    if (!Number.isFinite(parsed) || parsed <= 0) {
      process.stderr.write(
        `\nError: the maximum backup age "${configuredRaw}" is not a positive number of hours.\n` +
          'Fix the setting rather than letting the default stand in for it.\n',
      );
      process.exit(2);
    }
    configuredMaxAgeHours = parsed;
  }

  const target = targetFromFlags();
  const verdict = evaluateReceipt(receipt, {
    target,
    ledger,
    now: new Date(),
    maxAgeHours: DEFAULT_MAX_BACKUP_AGE_HOURS,
    configuredMaxAgeHours,
  });

  const failures = [...verdict.failures];

  // The stored object, re-read by this run. The receipt's own claim about the hash
  // is checked above; this checks the bucket against the receipt.
  const observedSha = (flagValue('--observed-sha256') as string).toLowerCase();
  const observedBytes = Number(flagValue('--observed-bytes'));
  if (validateReceiptShape(receipt).length === 0) {
    const record = receipt as BackupReceipt;
    if (observedSha !== record.object.sha256) {
      failures.push(
        `the object in the bucket hashes to ${observedSha}, but the receipt records ` +
          `${record.object.sha256}. The stored backup is not the file that was drilled.`,
      );
    }
    if (!Number.isFinite(observedBytes) || observedBytes !== record.object.bytes) {
      failures.push(
        `the object in the bucket is ${flagValue('--observed-bytes')} bytes, but the ` +
          `receipt records ${record.object.bytes}.`,
      );
    }
  }

  const accepted = failures.length === 0;

  process.stdout.write(
    `Receipt:  ${receiptPath}\n` +
      `Target:   ${target.environment} / ${target.databaseName} / ${target.databaseId}\n` +
      `Verdict:  ${accepted ? 'ACCEPTED' : 'REFUSED'}\n`,
  );
  for (const note of verdict.notes) process.stdout.write(`  note  ${note}\n`);
  for (const failure of failures) process.stderr.write(`  FAIL  ${failure}\n`);

  const outputPath = flagValue('--github-output') ?? (process.env.GITHUB_OUTPUT ?? '').trim();
  if (outputPath !== '') {
    if (accepted && validateReceiptShape(receipt).length === 0) {
      const record = receipt as BackupReceipt;
      // The key is published only after acceptance, so a downstream step cannot
      // use it as a way around this verdict.
      appendFileSync(
        outputPath,
        `accepted=true\nobject-key=${record.object.key}\nsha256=${record.object.sha256}\n`,
      );
    } else {
      appendFileSync(outputPath, 'accepted=false\n');
    }
  }

  if (!accepted) {
    process.stderr.write(
      '\nRefusing to treat this as a valid backup. Nothing may migrate on it.\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    '\nAccepted. This says the backup matches this target, that it replays from the\n' +
      'stored object, and that its snapshot ledger is the ledger the database reports\n' +
      'now. It does not say it contains rows written after it was taken: the ledger\n' +
      "fingerprint is about migrations, not about data.\n",
  );
  process.exit(0);
}

usage([
  command === undefined
    ? 'no subcommand: expected "target", "key", "create" or "verify"'
    : `unknown subcommand "${command}": expected "target", "key", "create" or "verify"`,
]);
