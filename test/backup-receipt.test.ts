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
      key: 'pilot/5d2bd39f/sadec_pilot-2026-10-31T13-00-00Z-run42.sql',
      bytes: 33_280,
      sha256: 'a'.repeat(64),
      readBackSha256: 'a'.repeat(64),
      uploadedAt: '2026-10-31T13:00:00Z',
    },
    source: { runId: '42', commitSha: 'b3da79653775a5a1741c652ce30402fdf2fda0d5' },
    ledger,
    ledgerFingerprint: fingerprintLedger(ledger),
    exportedAt: '2026-10-31T13:00:00Z',
    restore: {
      passed: true,
      tablesReplayed: 32,
      missingTables: [],
      foreignKeyViolations: 0,
      integrity: 'ok',
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
    // The fields are the whole contract: identifiers, sizes, hashes, verdicts.
    const keys = Object.keys(receipt()).sort();
    expect(keys).toEqual(
      ['exportedAt', 'ledger', 'ledgerFingerprint', 'object', 'restore', 'source', 'target', 'version'].sort(),
    );
    expect(Object.keys(receipt().restore).sort()).toEqual(
      ['foreignKeyViolations', 'integrity', 'missingTables', 'passed', 'tablesReplayed'].sort(),
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

  it('refuses a backup taken at a different migration ledger, and names both sides', () => {
    const verdict = evaluateReceipt(receipt(), expectation({ ledger: [...LEDGER, '0004_new.sql'] }));
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.join(' ')).toContain('0004_new.sql');
    expect(verdict.failures.join(' ')).toContain('does not describe');
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

  it('refuses a receipt dated in the future', () => {
    const verdict = evaluateReceipt(
      receipt({ exportedAt: '2027-01-01T00:00:00Z' }),
      expectation({ now: new Date('2026-10-31T13:10:00Z') }),
    );
    expect(verdict.failures.join(' ')).toContain('in the future');
  });

  it('says what it does not prove, even when it accepts', () => {
    const verdict = evaluateReceipt(receipt(), expectation());
    expect(verdict.notes.join(' ')).toContain('does not prove the backup contains rows written after');
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
    });
    expect(key).toBe(
      'pilot/5d2bd39f-93c0-400b-8207-586e17023cf2/' +
        'sadec_pilot-2026-10-31T13-00-00-000Z-run41234567890.sql',
    );
  });

  it('differs for two runs in the same second', () => {
    const base = {
      environment: 'pilot',
      databaseId: 'db',
      exportedAt: '2026-10-31T13:00:00.000Z',
    };
    expect(backupObjectKey({ ...base, runId: '1' })).not.toBe(backupObjectKey({ ...base, runId: '2' }));
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
  const exportPath = join(directory, 'sadec_pilot-2026-10-31T13-00-00-000Z.sql');
  const content = `CREATE TABLE workspaces (id TEXT PRIMARY KEY);\n${'-- padding\n'.repeat(200)}`;
  writeFileSync(exportPath, content);

  const ledgerPath = join(directory, 'ledger.json');
  writeFileSync(
    ledgerPath,
    JSON.stringify([{ results: LEDGER.map((name) => ({ name })), success: true }]),
  );

  const drillPassed = join(directory, 'drill-ok.json');
  writeFileSync(
    drillPassed,
    JSON.stringify({
      passed: true,
      tablesReplayed: 32,
      missingTables: [],
      foreignKeyViolations: 0,
      integrity: 'ok',
    }),
  );

  const drillFailed = join(directory, 'drill-failed.json');
  writeFileSync(
    drillFailed,
    JSON.stringify({
      passed: false,
      tablesReplayed: 31,
      missingTables: ['escrow_ledger_entries'],
      foreignKeyViolations: 0,
      integrity: 'ok',
    }),
  );

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
      '--read-back-sha256',
      readBack,
      '--ledger',
      ledgerPath,
      '--drill-report',
      drill,
      '--run-id',
      '4242',
      '--commit-sha',
      'b3da79653775a5a1741c652ce30402fdf2fda0d5',
      '--exported-at',
      new Date().toISOString(),
      '--out',
      out,
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

  it('writes a failed receipt for a failed drill, and exits non-zero', async () => {
    const out = join(directory, 'receipt-failed.json');
    await expect(run('node', createArguments(out, drillFailed))).rejects.toMatchObject({ code: 1 });
    const written = JSON.parse(readFileSync(out, 'utf8')) as BackupReceipt;
    expect(written.restore.passed).toBe(false);
    expect(written.restore.missingTables).toContain('escrow_ledger_entries');
  });

  it('verifies the receipt it just wrote against the same target and ledger', async () => {
    const out = join(directory, 'receipt-verify.json');
    await run('node', createArguments(out));
    const result = await run('node', [
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
      sha256Hex(content),
      '--observed-bytes',
      String(Buffer.byteLength(content)),
    ]);
    expect(result.stdout).toContain('ACCEPTED');
  });

  it('refuses when the object in the bucket is not the file that was drilled', async () => {
    const out = join(directory, 'receipt-observed.json');
    await run('node', createArguments(out));
    await expect(
      run('node', [
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
        'c'.repeat(64),
        '--observed-bytes',
        String(Buffer.byteLength(content)),
      ]),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('refuses a failed-drill receipt at verification time too', async () => {
    const out = join(directory, 'receipt-never.json');
    await expect(run('node', createArguments(out, drillFailed))).rejects.toMatchObject({ code: 1 });
    await expect(
      run('node', [
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
        sha256Hex(content),
        '--observed-bytes',
        String(Buffer.byteLength(content)),
      ]),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('refuses to create a receipt for a file that does not exist', async () => {
    const args = createArguments(join(directory, 'nope.json'), drillPassed);
    args[args.indexOf('--file') + 1] = join(directory, 'missing.sql');
    await expect(run('node', args)).rejects.toMatchObject({ code: 2 });
  });

  it('refuses an unreadable ledger rather than recording an empty schema', async () => {
    const args = createArguments(join(directory, 'nope2.json'), drillPassed);
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
    ]);
    expect(result.stdout.trim()).toContain('pilot/5d2bd39f-93c0-400b-8207-586e17023cf2/');
    expect(result.stdout.trim()).toContain('run77.sql');
  });
});
