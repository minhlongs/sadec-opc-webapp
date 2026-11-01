/**
 * The receipt a backup publishes, and the rules a migration checks it against.
 *
 * A backup is only a recovery point when four things are all true, and each of
 * them is a separate question:
 *
 *   1. the export was taken from **this** database (account, database id,
 *      environment);
 *   2. it was durably stored somewhere outside the runner, and the stored copy
 *      still hashes to what was exported;
 *   3. its schema matches the tree that is about to migrate;
 *   4. it replayed successfully into an isolated target, with foreign keys clean
 *      and integrity ok.
 *
 * The receipt records those answers. It deliberately contains **no customer data**
 * — no row contents, no emails, no names, no counts that identify a person — only
 * identifiers, sizes, hashes, timestamps and verdicts. A receipt is a claim about
 * a backup; it is never a copy of one.
 *
 * This module is the rules. `scripts/backup-receipt.ts` is the CLI that writes and
 * verifies, and the workflows treat a missing or unreadable receipt as a refusal.
 */

import { createHash } from 'node:crypto';

/**
 * Bumped when a field is added or its meaning changes; an old reader must refuse.
 *
 *   1 → 2: the ledger moved from "the live database, read after the export" to
 *   "the restored copy of the export, read from the drill"; the timeline was split
 *   into export / upload / read-back / drill; the run attempt joined the object
 *   key; and the drill now reports its own content digest and chain checks.
 *   A version-1 receipt is refused rather than read leniently, because its ledger
 *   fingerprint describes a different moment than the one a migration compares.
 */
export const RECEIPT_VERSION = 2;

/** How old a pilot backup may be and still be evidence for a migration. */
export const DEFAULT_MAX_BACKUP_AGE_HOURS = 24;

/** The minimum an export must weigh before it is treated as a database at all. */
export const MINIMUM_EXPORT_BYTES = 1024;

export interface BackupTarget {
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly environment: string;
}

/** Where the object lives, and what it hashes to. */
export interface BackupObject {
  readonly bucket: string;
  readonly key: string;
  readonly bytes: number;
  /** SHA-256 of the exact bytes written to the bucket, hex, lowercase. */
  readonly sha256: string;
  /** What a read-back of the stored object hashed to. Must equal `sha256`. */
  readonly readBackSha256: string;
  /** When the object was written. Separate from the export, which is earlier. */
  readonly uploadedAt: string;
  /** The key prefix the bucket's lifecycle and lock rules are written against. */
  readonly prefix: string;
}

/**
 * When each phase happened.
 *
 * These are separate fields because they are separate facts, and one timestamp
 * standing in for four invites exactly the claim this receipt must not make: that
 * the export, the upload and the drill describe one instant. They do not. A
 * migration's freshness limit is measured from **`exportFinishedAt`**, the moment
 * the snapshot stopped being taken — not from when the receipt was written.
 */
export interface BackupTimeline {
  readonly exportStartedAt: string;
  readonly exportFinishedAt: string;
  readonly readBackAt: string;
  readonly drillStartedAt: string;
  readonly drillFinishedAt: string;
}

/** What the replay proved, and how strong that evidence is. */
export interface RestoreDrillResult {
  readonly passed: boolean;
  readonly tablesReplayed: number;
  readonly missingTables: readonly string[];
  readonly foreignKeyViolations: number;
  readonly integrity: string;
  /** Joins across the quote → order → receipt chain that survived the replay. */
  readonly chainChecks: readonly { readonly name: string; readonly orphans: number }[];
  /** A hash over the evidence tables' rows, so a later restore can be compared. */
  readonly contentDigest: string;
  /** True when every evidence table replayed empty. Reported, not a failure. */
  readonly empty: boolean;
  /**
   * `bucket-readback` means the file drilled was downloaded back **out of the
   * bucket**, which is the only thing that tests the object a restore would use.
   * `exported-file` means the drill ran on the job's own copy; it proves the
   * export replays, and nothing about the stored object.
   */
  readonly drilledFrom: 'bucket-readback' | 'exported-file';
}

export interface BackupReceipt {
  readonly version: number;
  readonly target: BackupTarget;
  readonly object: BackupObject;
  readonly source: {
    readonly runId: string;
    /** The attempt, so a re-run cannot write to the same key as the attempt it replaces. */
    readonly runAttempt: string;
    readonly commitSha: string;
  };
  readonly timeline: BackupTimeline;
  /** Migration names read back from the **restored copy** of this export, in order. */
  readonly ledger: readonly string[];
  /** SHA-256 over the sorted ledger names: what a later tree is compared against. */
  readonly ledgerFingerprint: string;
  /** Where the ledger names came from. Only the restored copy is accepted. */
  readonly ledgerSource: 'restored-database';
  readonly restore: RestoreDrillResult;
}

/** Validates the shape of a parsed receipt, and returns the problems it found. */
export function validateReceiptShape(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) return ['the receipt is not an object'];
  const receipt = value as Record<string, unknown>;

  const version = receipt.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    problems.push('version is missing or not an integer');
  } else if (version !== RECEIPT_VERSION) {
    problems.push(
      `version is ${version}, and this tooling writes and reads version ${RECEIPT_VERSION}. ` +
        'A receipt from another version is not comparable field by field.',
    );
  }

  const target = receipt.target as Record<string, unknown> | undefined;
  if (typeof target !== 'object' || target === null) {
    problems.push('target is missing');
  } else {
    for (const key of ['accountId', 'databaseId', 'databaseName', 'environment']) {
      if (typeof target[key] !== 'string' || (target[key] as string).trim() === '') {
        problems.push(`target.${key} is missing or empty`);
      }
    }
  }

  const object = receipt.object as Record<string, unknown> | undefined;
  if (typeof object !== 'object' || object === null) {
    problems.push('object is missing');
  } else {
    for (const key of ['bucket', 'key', 'sha256', 'readBackSha256', 'uploadedAt', 'prefix']) {
      if (typeof object[key] !== 'string' || (object[key] as string).trim() === '') {
        problems.push(`object.${key} is missing or empty`);
      }
    }
    if (typeof object.bytes !== 'number' || !Number.isFinite(object.bytes)) {
      problems.push('object.bytes is missing or not a number');
    }
    for (const key of ['sha256', 'readBackSha256']) {
      const hash = object[key];
      if (typeof hash === 'string' && !/^[0-9a-f]{64}$/.test(hash)) {
        problems.push(`object.${key} is not a lowercase hex SHA-256`);
      }
    }
  }

  const source = receipt.source as Record<string, unknown> | undefined;
  if (typeof source !== 'object' || source === null) {
    problems.push('source is missing');
  } else {
    if (typeof source.runId !== 'string' || (source.runId as string).trim() === '') {
      problems.push('source.runId is missing or empty');
    }
    if (typeof source.runAttempt !== 'string' || (source.runAttempt as string).trim() === '') {
      problems.push('source.runAttempt is missing or empty');
    }
    if (typeof source.commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(source.commitSha)) {
      problems.push('source.commitSha is not a full 40-character commit SHA');
    }
  }

  const timeline = receipt.timeline as Record<string, unknown> | undefined;
  if (typeof timeline !== 'object' || timeline === null) {
    problems.push('timeline is missing');
  } else {
    for (const key of ['exportStartedAt', 'exportFinishedAt', 'readBackAt', 'drillStartedAt', 'drillFinishedAt']) {
      if (typeof timeline[key] !== 'string' || Number.isNaN(Date.parse(timeline[key] as string))) {
        problems.push(`timeline.${key} is missing or not a date`);
      }
    }
  }

  if (!Array.isArray(receipt.ledger) || (receipt.ledger as unknown[]).length === 0) {
    problems.push('ledger is missing or empty');
  } else if ((receipt.ledger as unknown[]).some((name) => typeof name !== 'string')) {
    problems.push('ledger holds something that is not a name');
  }
  if (typeof receipt.ledgerFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.ledgerFingerprint)) {
    problems.push('ledgerFingerprint is not a lowercase hex SHA-256');
  }
  if (receipt.ledgerSource !== 'restored-database') {
    problems.push(
      'ledgerSource is not "restored-database". A ledger read from the live database ' +
        'after an export describes the database as it is now, not the one that was exported.',
    );
  }

  const restore = receipt.restore as Record<string, unknown> | undefined;
  if (typeof restore !== 'object' || restore === null) {
    problems.push('restore is missing');
  } else {
    if (typeof restore.passed !== 'boolean') problems.push('restore.passed is missing or not a boolean');
    if (typeof restore.tablesReplayed !== 'number') problems.push('restore.tablesReplayed is missing');
    if (!Array.isArray(restore.missingTables)) problems.push('restore.missingTables is missing');
    if (typeof restore.foreignKeyViolations !== 'number') {
      problems.push('restore.foreignKeyViolations is missing');
    }
    if (typeof restore.integrity !== 'string') problems.push('restore.integrity is missing');
    if (typeof restore.contentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(restore.contentDigest)) {
      problems.push('restore.contentDigest is not a lowercase hex SHA-256');
    }
    if (typeof restore.empty !== 'boolean') problems.push('restore.empty is missing or not a boolean');
    if (!Array.isArray(restore.chainChecks)) {
      problems.push('restore.chainChecks is missing');
    } else if (
      (restore.chainChecks as unknown[]).some(
        (check) =>
          typeof (check as { name?: unknown }).name !== 'string' ||
          typeof (check as { orphans?: unknown }).orphans !== 'number',
      )
    ) {
      problems.push('restore.chainChecks holds something that is not a name and an orphan count');
    }
    if (restore.drilledFrom !== 'bucket-readback' && restore.drilledFrom !== 'exported-file') {
      problems.push('restore.drilledFrom is missing or not a recognised source');
    }
  }

  return problems;
}

/** A deterministic fingerprint over the applied migration names. */
export function fingerprintLedger(names: readonly string[]): string {
  // The names are sorted so the fingerprint depends on the set, not on the order
  // the ledger table happened to return. Names are compared byte for byte; no
  // normalisation, because a renamed migration is a different migration.
  return sha256Hex([...names].sort().join('\n'));
}

/**
 * SHA-256, synchronously, because this runs in scripts and in tests.
 *
 * `node:crypto` is used rather than a dependency: it is the same hash the
 * workflows compute with `sha256sum`, so a mismatch is a real mismatch.
 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The facts a migration supplies when it asks "is this receipt acceptable?". */
export interface ReceiptExpectation {
  readonly target: BackupTarget;
  /**
   * The migration names the database reports **now**, read by this run.
   *
   * Not the tree's files: during a migration the tree legitimately holds files
   * that are not applied yet, so comparing the snapshot with the tree would refuse
   * exactly the case the snapshot is for.
   */
  readonly ledger: readonly string[];
  /** Overridable so a test can pin "now"; the CLI passes the real clock. */
  readonly now: Date;
  readonly maxAgeHours?: number;
  /** `--max-age-hours` or `SADEC_MAX_BACKUP_AGE_HOURS`, if the operator set one. */
  readonly configuredMaxAgeHours?: number | null;
}

export interface ReceiptVerdict {
  readonly accepted: boolean;
  readonly failures: readonly string[];
  /** True things worth printing that are not failures. */
  readonly notes: string[];
}

/**
 * The acceptance rule for a backup before an irreversible migration.
 *
 * Every refusal names the field it compared and both values, because the operator
 * reading it in a failed job cannot open this file. Nothing here is satisfied by
 * "an object key was supplied": the receipt's own claims are checked against the
 * target and the tree, and the workflow separately re-reads the object so the hash
 * is not taken on trust either.
 */
export function evaluateReceipt(receipt: unknown, expectation: ReceiptExpectation): ReceiptVerdict {
  const failures: string[] = [];
  const notes: string[] = [];

  const shapeProblems = validateReceiptShape(receipt);
  if (shapeProblems.length > 0) {
    return {
      accepted: false,
      failures: [`the receipt could not be read: ${shapeProblems.join('; ')}`],
      notes,
    };
  }

  const record = receipt as BackupReceipt;

  // 1. Same target. All four fields, because any three of them can match while
  //    the fourth is the one that makes the backup useless: two environments in
  //    one account, two databases with one name.
  const pairs: [string, string, string][] = [
    ['accountId', record.target.accountId, expectation.target.accountId],
    ['databaseId', record.target.databaseId, expectation.target.databaseId],
    ['databaseName', record.target.databaseName, expectation.target.databaseName],
    ['environment', record.target.environment, expectation.target.environment],
  ];
  for (const [field, found, required] of pairs) {
    if (found !== required) {
      failures.push(
        `target.${field} is "${found}", but this migration targets "${required}". ` +
          'A backup of another database cannot be evidence for this one.',
      );
    }
  }

  // 2. The object was actually stored, and the read-back matched.
  if (record.object.sha256 !== record.object.readBackSha256) {
    failures.push(
      `the exported copy hashed to ${record.object.sha256}, but the stored copy read ` +
        `back as ${record.object.readBackSha256}. A backup whose read-back differs is ` +
        'not a copy of anything.',
    );
  }
  if (record.object.bytes < MINIMUM_EXPORT_BYTES) {
    failures.push(
      `the stored object is ${record.object.bytes} bytes, below the ${MINIMUM_EXPORT_BYTES}-byte ` +
        'floor. An export that small is an empty or truncated file, not a database.',
    );
  }

  // 3. The replay passed, on its own terms — and on the terms that matter to a
  //    restore rather than to a schema: the chain joins, and the file that was
  //    drilled is the object in the bucket, not the job's own copy.
  if (!record.restore.passed) {
    failures.push('the restore drill did not pass, so the backup has never been shown restorable.');
  }
  if (record.restore.missingTables.length > 0) {
    failures.push(
      `the replay was missing ${record.restore.missingTables.join(', ')}. A restore ` +
        'that comes back without a table is not a restore.',
    );
  }
  if (record.restore.foreignKeyViolations !== 0) {
    failures.push(
      `the replay left ${record.restore.foreignKeyViolations} foreign key violation(s).`,
    );
  }
  if (record.restore.integrity !== 'ok') {
    failures.push(`integrity_check said "${record.restore.integrity}", not "ok".`);
  }
  const brokenChains = record.restore.chainChecks.filter((check) => check.orphans !== 0);
  if (brokenChains.length > 0) {
    failures.push(
      'the replayed data has rows whose parent is missing: ' +
        `${brokenChains.map((check) => `${check.name} (${check.orphans})`).join(', ')}. ` +
        'A restore that loses the quote → order → receipt joins has not restored the data.',
    );
  }
  if (record.restore.contentDigest === '') {
    failures.push('the drill recorded no content digest, so no later restore can be compared with it.');
  }
  if (record.restore.drilledFrom !== 'bucket-readback') {
    failures.push(
      `the drill ran on "${record.restore.drilledFrom}", not on the object read back from the ` +
        'bucket. A drill of the job workspace copy proves the export replays and says nothing ' +
        'about the bytes that were stored; the object must be downloaded again and drilled.',
    );
  }

  // 3b. The timeline has to be a sequence, not four independent timestamps. An
  //     export that "finished" before it started, or a drill that finished before
  //     the upload it drilled, is a record of something that did not happen.
  const steps: [string, string][] = [
    ['exportStartedAt', record.timeline.exportStartedAt],
    ['exportFinishedAt', record.timeline.exportFinishedAt],
    ['object.uploadedAt', record.object.uploadedAt],
    ['readBackAt', record.timeline.readBackAt],
    ['drillStartedAt', record.timeline.drillStartedAt],
    ['drillFinishedAt', record.timeline.drillFinishedAt],
  ];
  for (let index = 1; index < steps.length; index += 1) {
    const [previousName, previousValue] = steps[index - 1] as [string, string];
    const [name, value] = steps[index] as [string, string];
    if (Date.parse(value) < Date.parse(previousValue)) {
      failures.push(
        `the receipt's timeline runs backwards: ${name} (${value}) is before ` +
          `${previousName} (${previousValue}). These are separate phases and are recorded ` +
          'separately; one of them is wrong.',
      );
    }
  }

  // 4. The schema matches the tree about to migrate.
  const expectedFingerprint = fingerprintLedger(expectation.ledger);
  if (record.ledgerFingerprint !== expectedFingerprint) {
    const receiptOnly = record.ledger.filter((name) => !expectation.ledger.includes(name));
    const treeOnly = expectation.ledger.filter((name) => !record.ledger.includes(name));
    failures.push(
      "the backup's snapshot ledger is not the ledger the database reports now: " +
        `receipt fingerprint ${record.ledgerFingerprint}, live fingerprint ${expectedFingerprint}. ` +
        `Applied in the backup but not now: ${receiptOnly.join(', ') || '(none)'}. ` +
        `Reported now but not in the backup: ${treeOnly.join(', ') || '(none)'}. ` +
        'A migration ran between this export and this check, so the backup describes ' +
        'a schema the database no longer has. Take a new backup; do not reuse this one.',
    );
  }

  // 5. Freshness, against a threshold that is stated rather than implied.
  const hours = expectation.configuredMaxAgeHours ?? expectation.maxAgeHours ?? DEFAULT_MAX_BACKUP_AGE_HOURS;
  if (!Number.isFinite(hours) || hours <= 0) {
    failures.push(
      `the maximum backup age is "${hours}", which is not a positive number of hours. ` +
        'An unusable threshold is a refusal rather than a default nobody chose.',
    );
  } else {
    // Freshness is measured from the moment the snapshot finished being taken, not
    // from when the receipt was written. An upload that took an hour is an hour of
    // writes this backup does not contain.
    const exportedAt = Date.parse(record.timeline.exportFinishedAt);
    const ageHours = (expectation.now.getTime() - exportedAt) / 3_600_000;
    if (ageHours < 0) {
      failures.push(
        `the receipt says its export finished at ${record.timeline.exportFinishedAt}, which is in the future ` +
          'relative to this run. Check the clock, not the backup.',
      );
    } else if (ageHours > hours) {
      failures.push(
        `the backup is ${ageHours.toFixed(1)} hours old, past the ${hours}-hour limit. ` +
          'Take a new backup: an old one cannot contain what was written after it.',
      );
    } else {
      notes.push(`backup age ${ageHours.toFixed(1)} h, within the ${hours}-hour limit`);
    }
  }

  // 6. A claim worth saying out loud, because a green migration would otherwise
  //    imply more than this rule proves.
  notes.push(
    'This proves the backup matched this target, that the object in the bucket is the ' +
      'file that was drilled, that it replays with its chain joins intact, and that the ' +
      'snapshot ledger is the ledger the live database reports now.',
  );
  notes.push(
    'The ledger fingerprint is a statement about **which migrations were applied**, not ' +
      'about the rows. It cannot show that the data is unchanged: rows written between ' +
      'the export and this check exist only in the live database, and a matching ' +
      'fingerprint says nothing about them. See docs/OPERATIONS-PILOT.md §4.',
  );
  notes.push(
    'GitHub concurrency serialises these workflows. It does not serialise the ' +
      'application: the Worker can write to this database while a backup runs, and ' +
      'a write that lands during the export is not in the snapshot.',
  );
  if (record.restore.empty) {
    notes.push(
      'Every evidence table replayed empty. That is a valid restore point for an empty ' +
        'pilot, and it is also what a backup of the wrong database looks like — confirm ' +
        'the target fields above before migrating on it.',
    );
  }

  return { accepted: failures.length === 0, failures, notes };
}

/** The prefix lifecycle and lock rules are written against. */
export function backupPrefix(environment: string): string {
  return `${environment}/`;
}

/**
 * The object key: unique per environment, database, time, run **and attempt**.
 *
 * A unique key stops two runs colliding. It does **not** make an object immutable:
 * anyone holding a write token can `put` the same key again and replace the bytes,
 * and a listing would look exactly the same afterwards. What protects a stored
 * backup is a bucket lock rule over the prefix, not the key's shape — which is why
 * the preflight treats a missing lock as a failure rather than a note, and why
 * `docs/R2-BACKUP-DESIGN.md` states the token's rights separately.
 *
 * The attempt is part of the key because a re-run of the same workflow run has the
 * same `run_id` and a later timestamp; without the attempt, a re-run seconds after
 * a failed one could land on the same second and overwrite the object a receipt
 * already points at.
 */
export function backupObjectKey(input: {
  environment: string;
  databaseId: string;
  exportedAt: string;
  runId: string;
  runAttempt: string;
}): string {
  const stamp = input.exportedAt.replace(/[:.]/g, '-');
  // The environment and database lead, so a lifecycle rule or a lock rule can be
  // written per target and a mis-filed object is visible in a listing.
  return (
    `${backupPrefix(input.environment)}${input.databaseId}/` +
    `sadec_${input.environment}-${stamp}-run${input.runId}-attempt${input.runAttempt}.sql`
  );
}
