import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
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
} from '../scripts/backup-receipt-rules.ts';

/**
 * The receipt is the only thing standing between "we have a backup" and a
 * migration that cannot be undone. Each refusal below is a way that claim can be
 * false while every file involved looks perfectly normal:
 *
 *   - the backup is of another database (right name, wrong id);
 *   - the upload lost bytes, and only the read-back would notice;
 *   - the drill never really ran, or ran and lost a table;
 *   - the schema moved on, so the backup describes a database that no longer exists;
 *   - the backup is old enough that everything written since is unprotected;
 *   - the object in the bucket is not the file that was drilled.
 */

const run = promisify(execFile);
const directory = mkdtempSync(join(tmpdir(), 'sadec-receipt-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const LEDGER = ['0001_init.sql', '0002_orders.sql', '0003_billing.sql'];

function receipt(overrides: Partial<BackupReceipt> = {}): BackupReceipt {
  const ledger = overrides.ledger ?? LEDGER;
  return {
    version: RECEIPT_VERSION,
    target: {
      accountId: 'f691e83094f776311a1bfe3f8b126f1c',
      databaseId: '5d2bd39f-93c0-400b-8207-586e17023cf2',
      databaseName: 'sadec-pilot',
      environment: 'pilot',
    },
    object: {
      bucket: 'sadec-pilot-backups',
      key: 'pilot/5d2bd39f/sadec_pilot-2026-10-31T13-00-00Z-run42-attempt1.sql',
      bytes: 33_280,
      sha256: 'a'.repeat(64),
      readBackSha256: 'a'.repeat(64),
      uploadedAt: '2026-10-31T12:58:00Z',
      prefix: 'pilot/',
    },
    source: {
      runId: '42',
      runAttempt: '1',
      commitSha: 'b3da79653775a5a1741c652ce30402fdf2fda0d5',
    },
    timeline: {
      exportStartedAt: '2026-10-31T12:55:00Z',
      exportFinishedAt: '2026-10-31T12:56:00Z',
      readBackAt: '2026-10-31T12:58:00Z',
      drillStartedAt: '2026-10-31T12:59:00Z',
      drillFinishedAt: '2026-10-31T13:00:00Z',
    },
    ledger,
    ledgerFingerprint: fingerprintLedger(ledger),
    ledgerSource: 'restored-database',
    restore: {
      passed: true,
      tablesReplayed: 32,
      missingTables: [],
      foreignKeyViolations: 0,
      integrity: 'ok',
      chainChecks: [
        { name: 'orders → workspaces', orphans: 0 },
        { name: 'receipts → orders', orphans: 0 },
      ],
      contentDigest: 'd'.repeat(64),
      empty: false,
      drilledFrom: 'bucket-readback',
    },
    ...overrides,
  };
}

function expectation(overrides: Partial<Parameters<typeof evaluateReceipt>[1]> = {}) {
  return {
    target: receipt().target,
    ledger: LEDGER,
    now: new Date('2026-10-31T13:10:00Z'),
    ...overrides,
  };
}

describe('the receipt a backup writes', () => {
  it('is accepted when every claim holds', () => {
    const verdict = evaluateReceipt(receipt(), expectation());
    expect(verdict.failures).toEqual([]);
    expect(verdict.accepted).toBe(true);
  });

  it('records no customer data at all', () => {
    // The fields are the whole contract: identifiers, sizes, hashes, verdicts and
    // timestamps. Adding one is a deliberate act, which is why this list is exact.
    const keys = Object.keys(receipt()).sort();
    expect(keys).toEqual(
      [
        'ledger',
        'ledgerFingerprint',
        'ledgerSource',
        'object',
        'restore',
        'source',
        'target',
        'timeline',
        'version',
      ].sort(),
    );
    expect(Object.keys(receipt().restore).sort()).toEqual(
      [
        'chainChecks',
        'contentDigest',
        'drilledFrom',
        'empty',
        'foreignKeyViolations',
        'integrity',
        'missingTables',
        'passed',
        'tablesReplayed',
      ].sort(),
    );
  });

  it('refuses a receipt from another database in the same account', () => {
    const verdict = evaluateReceipt(
      receipt(),
      expectation({ target: { ...receipt().target, databaseId: '00000000-0000-0000-0000-000000000000' } }),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('target.databaseId');
  });

  it('refuses a receipt from another environment or another account', () => {
    const wrongEnvironment = evaluateReceipt(
      receipt({ target: { ...receipt().target, environment: 'demo' } }),
      expectation(),
    );
    expect(wrongEnvironment.failures.join(' ')).toContain('environment');

    const wrongAccount = evaluateReceipt(
      receipt({ target: { ...receipt().target, accountId: 'f'.repeat(32) } }),
      expectation(),
    );
    expect(wrongAccount.failures.join(' ')).toContain('accountId');
  });

  it('refuses a backup whose stored copy does not hash to the export', () => {
    const verdict = evaluateReceipt(
      receipt({ object: { ...receipt().object, readBackSha256: 'b'.repeat(64) } }),
      expectation(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('read back');
  });

  it('refuses a truncated export', () => {
    const verdict = evaluateReceipt(receipt({ object: { ...receipt().object, bytes: 12 } }), expectation());
    expect(verdict.failures.join(' ')).toContain('below the');
  });

  it('refuses a backup whose drill did not pass, or lost a table, or left keys broken', () => {
    const notPassed = evaluateReceipt(
      receipt({ restore: { ...receipt().restore, passed: false } }),
      expectation(),
    );
    expect(notPassed.accepted).toBe(false);

    const missing = evaluateReceipt(
      receipt({ restore: { ...receipt().restore, missingTables: ['escrow_ledger_entries'] } }),
      expectation(),
    );
    expect(missing.failures.join(' ')).toContain('escrow_ledger_entries');

    const broken = evaluateReceipt(
      receipt({ restore: { ...receipt().restore, foreignKeyViolations: 3 } }),
      expectation(),
    );
    expect(broken.failures.join(' ')).toContain('3 foreign key');

    const integrity = evaluateReceipt(
      receipt({ restore: { ...receipt().restore, integrity: 'database disk image is malformed' } }),
      expectation(),
    );
    expect(integrity.failures.join(' ')).toContain('integrity_check');
  });

  it('refuses a snapshot whose ledger is not the one the database reports now', () => {
    const verdict = evaluateReceipt(receipt(), expectation({ ledger: [...LEDGER, '0004_new.sql'] }));
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('0004_new.sql');
    expect(verdict.failures.join(' ')).toContain('Take a new backup');
  });

  it('refuses a backup older than the limit, and says how old it is', () => {
    const verdict = evaluateReceipt(
      receipt(),
      expectation({ now: new Date('2026-11-02T13:00:00Z') }),
    );
    expect(verdict.failures.join(' ')).toContain(`${DEFAULT_MAX_BACKUP_AGE_HOURS}-hour limit`);
    expect(verdict.failures.join(' ')).toContain('hours old');
  });

  it('honours a configured age limit over the default', () => {
    const strict = evaluateReceipt(
      receipt(),
      expectation({ now: new Date('2026-10-31T15:00:00Z'), configuredMaxAgeHours: 1 }),
    );
    expect(strict.accepted).toBe(false);

    const loose = evaluateReceipt(
      receipt(),
      expectation({ now: new Date('2026-10-31T15:00:00Z'), configuredMaxAgeHours: 48 }),
    );
    expect(loose.accepted).toBe(true);
  });

  it('refuses an unusable age limit rather than falling back to a default nobody chose', () => {
    const verdict = evaluateReceipt(receipt(), expectation({ configuredMaxAgeHours: 0 }));
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('not a positive number of hours');
  });

  it('refuses a receipt whose export finished in the future', () => {
    const future = receipt();
    const verdict = evaluateReceipt(
      receipt({
        timeline: { ...future.timeline, exportFinishedAt: '2027-01-01T00:00:00Z' },
      }),
      expectation({ now: new Date('2026-10-31T13:10:00Z') }),
    );
    expect(verdict.failures.join(' ')).toContain('in the future');
  });

  it('measures freshness from the end of the export, not from the receipt', () => {
    // The upload and the drill take time, and rows written during them are not in
    // the snapshot. A receipt written an hour after the export is an hour older
    // than it looks if the age is measured from the wrong end.
    const base = receipt();
    const verdict = evaluateReceipt(
      receipt({ timeline: { ...base.timeline, exportFinishedAt: '2026-10-31T10:00:00Z' } }),
      expectation({ now: new Date('2026-10-31T13:10:00Z'), configuredMaxAgeHours: 2 }),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('hours old');
  });

  it('refuses a drill that ran on the copy in the job workspace instead of the stored object', () => {
    const verdict = evaluateReceipt(
      receipt({ restore: { ...receipt().restore, drilledFrom: 'exported-file' } }),
      expectation(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('read back from the bucket');
  });

  it('refuses a replay with a broken chain, even when keys and integrity are clean', () => {
    const verdict = evaluateReceipt(
      receipt({
        restore: {
          ...receipt().restore,
          chainChecks: [{ name: 'receipts → orders', orphans: 4 }],
        },
      }),
      expectation(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('receipts → orders');
  });

  it('refuses a receipt whose timeline runs backwards', () => {
    const base = receipt();
    const verdict = evaluateReceipt(
      receipt({
        timeline: { ...base.timeline, drillFinishedAt: '2026-10-31T12:50:00Z' },
      }),
      expectation(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('backwards');
  });

  it('refuses a ledger that claims to come from the live database', () => {
    const verdict = evaluateReceipt(
      receipt({ ledgerSource: 'live-database' as 'restored-database' }),
      expectation(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('restored-database');
  });

  it('says what it does not prove, even when it accepts', () => {
    const verdict = evaluateReceipt(receipt(), expectation());
    const notes = verdict.notes.join(' ');
    expect(notes).toContain('not about the rows');
    expect(notes).toContain('rows written between');
    expect(notes).toContain('does not serialise the application');
  });

  it('warns loudly when the snapshot replayed empty', () => {
    const verdict = evaluateReceipt(
      receipt({ restore: { ...receipt().restore, empty: true } }),
      expectation(),
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.notes.join(' ')).toContain('Every evidence table replayed empty');
  });
});

describe('receipt shape', () => {
  it('refuses an object that is not a receipt at all', () => {
    expect(evaluateReceipt('a string', expectation()).accepted).toBe(false);
    expect(evaluateReceipt({}, expectation()).accepted).toBe(false);
  });

  it('refuses a receipt from another version', () => {
    const problems = validateReceiptShape({ ...receipt(), version: 99 });
    expect(problems.join(' ')).toContain('version is 99');
  });

  it('refuses a hash that is not a lowercase hex SHA-256', () => {
    const problems = validateReceiptShape({
      ...receipt(),
      object: { ...receipt().object, sha256: 'ABC' },
    });
    expect(problems.join(' ')).toContain('not a lowercase hex SHA-256');
  });

  it('refuses a ledger with no migrations in it', () => {
    const problems = validateReceiptShape({ ...receipt(), ledger: [] });
    expect(problems.join(' ')).toContain('ledger is missing or empty');
  });

  it('fails closed on an unreadable field rather than guessing', () => {
    const problems = validateReceiptShape({ ...receipt(), restore: { passed: 'yes' } });
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('the object key', () => {
  it('carries the environment, the database id, the time and the run', () => {
    const key = backupObjectKey({
      environment: 'pilot',
      databaseId: '5d2bd39f-93c0-400b-8207-586e17023cf2',
      exportedAt: '2026-10-31T13:00:00.000Z',
      runId: '41234567890',
      runAttempt: '1',
    });
    expect(key).toBe(
      'pilot/5d2bd39f-93c0-400b-8207-586e17023cf2/' +
        'sadec_pilot-2026-10-31T13-00-00-000Z-run41234567890-attempt1.sql',
    );
  });

  it('differs for two runs in the same second', () => {
    const base = {
      environment: 'pilot',
      databaseId: 'db',
      exportedAt: '2026-10-31T13:00:00.000Z',
      runAttempt: '1',
    };
    expect(backupObjectKey({ ...base, runId: '1' })).not.toBe(backupObjectKey({ ...base, runId: '2' }));
  });

  it('differs for two attempts of the same run, which can share a second', () => {
    // A re-run keeps `run_id` and can start on the same second as the attempt it
    // replaces. Without the attempt in the key, the re-run would overwrite the
    // object a receipt already points at.
    const base = {
      environment: 'pilot',
      databaseId: 'db',
      exportedAt: '2026-10-31T13:00:00.000Z',
      runId: '7',
    };
    expect(backupObjectKey({ ...base, runAttempt: '1' })).not.toBe(
      backupObjectKey({ ...base, runAttempt: '2' }),
    );
  });

  it('lives under the prefix the lock and lifecycle rules are written against', () => {
    const key = backupObjectKey({
      environment: 'pilot',
      databaseId: 'db',
      exportedAt: '2026-10-31T13:00:00.000Z',
      runId: '7',
      runAttempt: '1',
    });
    expect(key.startsWith(backupPrefix('pilot'))).toBe(true);
  });
});

describe('fingerprintLedger', () => {
  it('depends on the set, not the order the ledger came back in', () => {
    expect(fingerprintLedger(['b.sql', 'a.sql'])).toBe(fingerprintLedger(['a.sql', 'b.sql']));
  });

  it('changes when a migration is renamed, because that is a different migration', () => {
    expect(fingerprintLedger(['0001_a.sql'])).not.toBe(fingerprintLedger(['0001_a-renamed.sql']));
  });
});

describe('the CLI', () => {
  const content = `CREATE TABLE workspaces (id TEXT PRIMARY KEY);\n${'-- padding\n'.repeat(200)}`;
  const exportPath = join(directory, 'sadec_pilot-2026-10-31T13-00-00-000Z.sql');
  writeFileSync(exportPath, content);

  // What the *live* database reports right now. It is compared with the receipt's
  // snapshot ledger, never used to build the receipt.
  const ledgerPath = join(directory, 'live-ledger.json');
  writeFileSync(
    ledgerPath,
    JSON.stringify([{ results: LEDGER.map((name) => ({ name })), success: true }]),
  );

  function drillReport(overrides: Record<string, unknown> = {}) {
    return {
      reportVersion: 1,
      passed: true,
      tablesReplayed: 32,
      missingTables: [],
      foreignKeyViolations: 0,
      integrity: 'ok',
      // These come out of the replayed snapshot, which is what the receipt records.
      ledger: LEDGER,
      ledgerFingerprint: fingerprintLedger(LEDGER),
      ledgerSource: 'restored-database',
      evidence: [{ table: 'workspaces', rows: 2, digest: 'e'.repeat(64) }],
      contentDigest: 'd'.repeat(64),
      chainChecks: [{ name: 'orders → workspaces', orphans: 0 }],
      empty: false,
      replay: 'full export, including the migration ledger',
      drilledFrom: 'bucket-readback',
      ...overrides,
    };
  }

  const drillPassed = join(directory, 'drill-ok.json');
  writeFileSync(drillPassed, JSON.stringify(drillReport()));

  const drillFailed = join(directory, 'drill-failed.json');
  writeFileSync(
    drillFailed,
    JSON.stringify(
      drillReport({
        passed: false,
        tablesReplayed: 31,
        missingTables: ['escrow_ledger_entries'],
      }),
    ),
  );

  /** The drill the action must not be able to pass off as evidence about the object. */
  const drillLocalOnly = join(directory, 'drill-local.json');
  writeFileSync(drillLocalOnly, JSON.stringify(drillReport({ drilledFrom: 'exported-file' })));

  const drillNoLedger = join(directory, 'drill-no-ledger.json');
  writeFileSync(drillNoLedger, JSON.stringify(drillReport({ ledger: [], ledgerFingerprint: '' })));

  const TIMES = {
    exportStarted: '2026-10-31T12:55:00Z',
    exportFinished: '2026-10-31T13:00:00Z',
    uploaded: '2026-10-31T13:00:30Z',
    readBack: '2026-10-31T13:01:00Z',
    drillStarted: '2026-10-31T13:02:00Z',
    drillFinished: '2026-10-31T13:03:00Z',
  };

  function createArguments(out: string, drill = drillPassed, readBack = sha256Hex(content)): string[] {
    return [
      'scripts/backup-receipt.ts',
      'create',
      '--env',
      'pilot',
      '--file',
      exportPath,
      '--account-id',
      'f691e83094f776311a1bfe3f8b126f1c',
      '--database-id',
      '5d2bd39f-93c0-400b-8207-586e17023cf2',
      '--database-name',
      'sadec-pilot',
      '--bucket',
      'sadec-pilot-backups',
      '--key',
      // The key the action derived and uploaded to. `create` recomputes it from
      // the same inputs and refuses a mismatch, so the receipt cannot name an
      // object the job never wrote.
      `pilot/5d2bd39f-93c0-400b-8207-586e17023cf2/sadec_pilot-${TIMES.exportFinished.replace(/[:.]/g, '-')}-run4242-attempt1.sql`,
      '--read-back-sha256',
      readBack,
      '--drill-report',
      drill,
      '--run-id',
      '4242',
      '--run-attempt',
      '1',
      '--commit-sha',
      'b3da79653775a5a1741c652ce30402fdf2fda0d5',
      '--export-started-at',
      TIMES.exportStarted,
      '--export-finished-at',
      TIMES.exportFinished,
      '--uploaded-at',
      TIMES.uploaded,
      '--read-back-at',
      TIMES.readBack,
      '--drill-started-at',
      TIMES.drillStarted,
      '--drill-finished-at',
      TIMES.drillFinished,
      '--out',
      out,
    ];
  }

  function verifyArguments(out: string, observed = sha256Hex(content)): string[] {
    return [
      'scripts/backup-receipt.ts',
      'verify',
      '--env',
      'pilot',
      '--receipt',
      out,
      '--account-id',
      'f691e83094f776311a1bfe3f8b126f1c',
      '--database-id',
      '5d2bd39f-93c0-400b-8207-586e17023cf2',
      '--database-name',
      'sadec-pilot',
      '--ledger',
      ledgerPath,
      '--observed-sha256',
      observed,
      '--observed-bytes',
      String(Buffer.byteLength(content)),
    ];
  }

  it('writes a receipt recording the file it hashed and the drill it was given', async () => {
    const out = join(directory, 'receipt-ok.json');
    const result = await run('node', createArguments(out));
    expect(result.stdout).toContain('Receipt written');
    const written = JSON.parse(readFileSync(out, 'utf8')) as BackupReceipt;
    expect(written.object.sha256).toBe(sha256Hex(content));
    expect(written.object.bytes).toBe(Buffer.byteLength(content));
    expect(written.restore.passed).toBe(true);
    expect(written.ledgerFingerprint).toBe(fingerprintLedger(LEDGER));
  });

  it('takes the ledger from the drill report, not from the live database', async () => {
    const out = join(directory, 'receipt-ledger-source.json');
    await run('node', createArguments(out));
    const written = JSON.parse(readFileSync(out, 'utf8')) as BackupReceipt;
    expect(written.ledgerSource).toBe('restored-database');
    expect(written.ledger).toEqual(LEDGER);
    // The CLI is not given the live ledger when it writes a receipt at all: there
    // is no `--ledger` flag on `create`, so the two cannot be confused.
    expect(createArguments(out)).not.toContain('--ledger');
  });

  it('records each phase separately, and the run attempt in the key', async () => {
    const out = join(directory, 'receipt-timeline.json');
    await run('node', createArguments(out));
    const written = JSON.parse(readFileSync(out, 'utf8')) as BackupReceipt;
    expect(written.timeline).toEqual({
      exportStartedAt: TIMES.exportStarted,
      exportFinishedAt: TIMES.exportFinished,
      readBackAt: TIMES.readBack,
      drillStartedAt: TIMES.drillStarted,
      drillFinishedAt: TIMES.drillFinished,
    });
    expect(written.object.uploadedAt).toBe(TIMES.uploaded);
    expect(written.object.key).toContain('-run4242-attempt1.sql');
    expect(written.source.runAttempt).toBe('1');
  });

  it('writes a failed receipt for a failed drill, and exits non-zero', async () => {
    const out = join(directory, 'receipt-failed.json');
    await expect(run('node', createArguments(out, drillFailed))).rejects.toMatchObject({ code: 1 });
    const written = JSON.parse(readFileSync(out, 'utf8')) as BackupReceipt;
    expect(written.restore.passed).toBe(false);
    expect(written.restore.missingTables).toContain('escrow_ledger_entries');
  });

  it('refuses a key it did not derive, rather than describing an object nobody wrote', async () => {
    const out = join(directory, 'receipt-wrong-key.json');
    const args = createArguments(out);
    args[args.indexOf('--key') + 1] = 'pilot/somewhere-else.sql';
    const failure = await run('node', args).catch((error: { stderr: string; code: number }) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain('did not write');
  });

  it('refuses a key outside the environment prefix, where the rules do not apply', async () => {
    const out = join(directory, 'receipt-outside.json');
    const args = createArguments(out);
    const keyIndex = args.indexOf('--key') + 1;
    args[keyIndex] = String(args[keyIndex]).replace(/^pilot\//, '');
    const failure = await run('node', args).catch((error: { stderr: string; code: number }) => error);
    expect(failure).toMatchObject({ code: 1 });
  });

  it('refuses to write a receipt when the drill report carries no ledger', async () => {
    const out = join(directory, 'receipt-no-ledger.json');
    const failure = await run('node', createArguments(out, drillNoLedger)).catch(
      (error: { stderr: string; code: number }) => error,
    );
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain('carries no ledger');
  });

  it('verifies the receipt it just wrote against the same target and live ledger', async () => {
    const out = join(directory, 'receipt-verify.json');
    await run('node', createArguments(out));
    const result = await run('node', verifyArguments(out));
    expect(result.stdout).toContain('ACCEPTED');
  });

  it('accepts the `pnpm <script> -- <subcommand>` form an operator types', async () => {
    // Reproduced before the fix: pnpm passes the literal `--` through, the CLI read
    // it as the subcommand, and every documented invocation failed with a usage
    // error. This runs the CLI the way the workflow does, separator included.
    const result = await run('node', [
      'scripts/backup-receipt.ts',
      '--',
      'target',
      '--env',
      'pilot',
    ]);
    expect(result.stdout).toContain('database-id=5d2bd39f-93c0-400b-8207-586e17023cf2');
  });

  it('refuses a receipt whose receipt points at a drill of the local copy', async () => {
    const out = join(directory, 'receipt-local-drill.json');
    await run('node', createArguments(out, drillLocalOnly));
    const failure = await run('node', verifyArguments(out)).catch(
      (error: { stderr: string; code: number }) => error,
    );
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain('read back from the bucket');
  });

  it('refuses when the object in the bucket is not the file that was drilled', async () => {
    const out = join(directory, 'receipt-observed.json');
    await run('node', createArguments(out));
    await expect(run('node', verifyArguments(out, 'c'.repeat(64)))).rejects.toMatchObject({
      code: 1,
    });
  });

  it('refuses a failed-drill receipt at verification time too', async () => {
    const out = join(directory, 'receipt-never.json');
    await expect(run('node', createArguments(out, drillFailed))).rejects.toMatchObject({ code: 1 });
    await expect(run('node', verifyArguments(out))).rejects.toMatchObject({ code: 1 });
  });

  it('refuses to create a receipt for a file that does not exist', async () => {
    const args = createArguments(join(directory, 'nope.json'), drillPassed);
    args[args.indexOf('--file') + 1] = join(directory, 'missing.sql');
    await expect(run('node', args)).rejects.toMatchObject({ code: 2 });
  });

  it('refuses an unreadable live ledger rather than comparing against nothing', async () => {
    const out = join(directory, 'receipt-bad-live.json');
    await run('node', createArguments(out));
    const args = verifyArguments(out);
    args[args.indexOf('--ledger') + 1] = join(directory, 'not-a-ledger.json');
    writeFileSync(join(directory, 'not-a-ledger.json'), 'Error: nope');
    await expect(run('node', args)).rejects.toMatchObject({ code: 1 });
  });

  it('prints the pilot database identity from the repository config', async () => {
    const result = await run('node', ['scripts/backup-receipt.ts', 'target', '--env', 'pilot']);
    expect(result.stdout).toContain('database-id=5d2bd39f-93c0-400b-8207-586e17023cf2');
    expect(result.stdout).toContain('database-name=sadec-pilot');
  });

  it('derives the same key the composite action uploads to', async () => {
    const result = await run('node', [
      'scripts/backup-receipt.ts',
      'key',
      '--env',
      'pilot',
      '--database-id',
      '5d2bd39f-93c0-400b-8207-586e17023cf2',
      '--exported-at',
      '2026-10-31T13:00:00Z',
      '--run-id',
      '77',
      '--run-attempt',
      '2',
    ]);
    expect(result.stdout.trim()).toContain('pilot/5d2bd39f-93c0-400b-8207-586e17023cf2/');
    expect(result.stdout.trim()).toContain('run77-attempt2.sql');
  });

  it('prints nothing but the value on stdout, so command substitution is safe', async () => {
    // The object key is captured with `$( )`. pnpm's banner goes to stderr in the
    // pnpm this repository pins, but the workflow calls the script directly anyway;
    // this asserts the value itself is the only line on stdout.
    const result = await run('node', [
      'scripts/backup-receipt.ts',
      'key',
      '--env',
      'pilot',
      '--database-id',
      '5d2bd39f-93c0-400b-8207-586e17023cf2',
      '--exported-at',
      '2026-10-31T13:00:00Z',
      '--run-id',
      '77',
      '--run-attempt',
      '1',
    ]);
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pilot\/[0-9a-f-]+\/sadec_pilot-.*\.sql$/);
  });
});
