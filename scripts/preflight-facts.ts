/**
 * The decision a Cloudflare preflight makes, and the config reading it needs.
 *
 * Separated from `scripts/cf-preflight.ts` so a test can exercise the decision
 * without a network and without a CLI that exits the process on import. The CLI
 * gathers facts with `fetch`; this file decides what the facts mean.
 */

import { readFileSync } from 'node:fs';

/** Where a deployment's own config states which database a binding means. */
export const CONFIG_PATH = 'wrangler.jsonc';
export const PILOT_BINDING = 'sadec_pilot';
export const PILOT_DATABASE_NAME = 'sadec-pilot';
export const PILOT_WORKER_NAME = 'sadec-flow-pilot';
/** The private backup bucket proposed in docs/R2-BACKUP-DESIGN.md. */
export const BACKUP_BUCKET_NAME = 'sadec-pilot-backups';
/** The retention the design proposes; the bucket must enforce at least this. */
export const PROPOSED_RETENTION_DAYS = 30;
/** The account this repository's `database_id`s belong to. Recorded, not secret. */
export const EXPECTED_ACCOUNT_ID = 'f691e83094f776311a1bfe3f8b126f1c';

/**
 * Strips whole-line `//` comments so a JSONC config can be parsed.
 *
 * Deliberately narrow: it removes lines whose first non-space characters are
 * `//`, and nothing else. A `//` inside a string — a URL in a value — is left
 * alone, and a trailing `// comment` after a value is not supported. Widening
 * this into a parser of its own would be a second implementation of a format
 * that only ever holds four keys here.
 */
export function stripLineComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * Parses JSONC: comments removed, and a trailing comma tolerated.
 *
 * `wrangler.jsonc` ends its object with `"d1_databases": [...],` and then `}`.
 * That trailing comma is valid in the format wrangler reads and invalid in strict
 * JSON, so `JSON.parse` alone refuses the file — which a test caught, and which
 * would have made the preflight report "the config declares no database" for a
 * config that declares four.
 *
 * The comma is dropped only immediately before a closing bracket, which is the
 * one place it cannot be part of a string in this file's shape.
 */
export function parseJsonc(source: string): unknown {
  const withoutComments = stripLineComments(source).replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutComments);
}

/** The `database_id` a config declares for one binding, or null. */
export function databaseIdFor(source: string, binding: string): string | null {
  let config: unknown;
  try {
    config = parseJsonc(source);
  } catch {
    return null;
  }
  const databases = (config as { d1_databases?: unknown }).d1_databases;
  if (!Array.isArray(databases)) return null;
  for (const entry of databases) {
    const record = entry as { binding?: unknown; database_id?: unknown };
    if (record.binding === binding && typeof record.database_id === 'string') {
      return record.database_id;
    }
  }
  return null;
}

/** One question, answered or not, as the report prints it. */
export interface Probe {
  readonly name: string;
  readonly state: 'PASS' | 'FAIL' | 'INFO';
  readonly detail: string;
}

/**
 * What the preflight is being run *for*.
 *
 * The questions are not the same for every purpose. A first deploy has no Worker
 * yet, and that is information. A deploy of a Worker whose presence could not be
 * confirmed is a deployment into the unknown, and that is a refusal. A backup
 * needs the bucket and its retention; a deploy does not care about either.
 */
export type PreflightPurpose = 'deploy' | 'migrate' | 'backup' | 'bootstrap' | 'inspect';

export interface R2Facts {
  /** `unknown` when the bucket could not be read at all: absent is `missing`. */
  readonly bucket: 'present' | 'missing' | 'unknown';
  readonly detail: string;
  /** A managed `r2.dev` domain or any custom domain makes the bucket public. */
  readonly publicAccess: 'none' | 'enabled' | 'unknown';
  readonly publicDetail: string;
  /** The longest expiry a lifecycle rule enforces on the backup prefix. */
  readonly retentionDays: number | null;
  readonly retentionDetail: string;
  /** The prefixes those expiry rules are scoped to; `''` is the whole bucket. */
  readonly retentionPrefixes?: readonly string[];
  /** Bucket lock rules, which also prevent overwrite and delete. */
  readonly lockDays: number | null;
  readonly lockDetail: string;
  /** The prefixes the lock rules are scoped to; `''` is the whole bucket. */
  readonly lockPrefixes?: readonly string[];
}

/** The prefix a backup object lives under for one environment. */
export function exportPrefix(environment = 'pilot'): string {
  return `${environment}/`;
}

/** True when a rule scoped to `prefix` applies to objects under `target`. */
export function prefixCovers(prefix: string, target: string): boolean {
  if (prefix === '') return true;
  return target.startsWith(prefix);
}

export interface PreflightFacts {
  readonly accountId: string | null;
  readonly tokenPresent: boolean;
  readonly expectedDatabaseId: string | null;
  readonly account: { readable: boolean; id: string | null; detail: string };
  readonly database: { found: boolean; id: string | null; detail: string };
  readonly worker: { state: 'present' | 'absent' | 'unknown'; detail: string };
  readonly access: { teamDomain: boolean; aud: boolean };
  /** Absent means the R2 questions were not asked, which no writing purpose allows. */
  readonly r2?: R2Facts;
  readonly purpose?: PreflightPurpose;
  readonly bucketName?: string;
}

/**
 * The report, in the order an operator should read it. A `FAIL` anywhere is a
 * refusal to continue; `INFO` is something to know before deploying.
 */
export function evaluatePreflight(facts: PreflightFacts): Probe[] {
  const probes: Probe[] = [];

  probes.push(
    facts.tokenPresent
      ? { name: 'token', state: 'PASS', detail: 'CLOUDFLARE_API_TOKEN is set (value not printed)' }
      : {
          name: 'token',
          state: 'FAIL',
          detail: 'CLOUDFLARE_API_TOKEN is empty. Add it as a secret on the GitHub Environment.',
        },
  );

  probes.push(
    facts.accountId === null
      ? {
          name: 'account id',
          state: 'FAIL',
          detail:
            'CLOUDFLARE_ACCOUNT_ID is not set. It is a repository or Environment variable, ' +
            'not a secret: the id is on the dashboard URL and in `wrangler whoami`.',
        }
      : facts.accountId === EXPECTED_ACCOUNT_ID
        ? { name: 'account id', state: 'PASS', detail: 'the expected account' }
        : {
            name: 'account id',
            state: 'FAIL',
            detail:
              `is "${facts.accountId}", but the database ids in ${CONFIG_PATH} belong to ` +
              `"${EXPECTED_ACCOUNT_ID}". Deploying here would target another account.`,
          },
  );

  probes.push(
    facts.account.readable
      ? {
          name: 'account access',
          state: 'PASS',
          detail: facts.account.detail,
        }
      : {
          name: 'account access',
          state: 'FAIL',
          detail:
            `${facts.account.detail} The token needs at least Account:Read on this account.`,
        },
  );

  if (!facts.database.found) {
    probes.push({ name: `database ${PILOT_DATABASE_NAME}`, state: 'FAIL', detail: facts.database.detail });
  } else if (facts.expectedDatabaseId === null) {
    probes.push({
      name: `database ${PILOT_DATABASE_NAME}`,
      state: 'FAIL',
      detail: `${CONFIG_PATH} declares no database_id for binding ${PILOT_BINDING}.`,
    });
  } else if (facts.database.id !== facts.expectedDatabaseId) {
    probes.push({
      name: `database ${PILOT_DATABASE_NAME}`,
      state: 'FAIL',
      detail:
        `is ${facts.database.id ?? '(no id)'}, but ${CONFIG_PATH} binds ${PILOT_BINDING} to ` +
        `${facts.expectedDatabaseId}. One of the two is wrong; a deploy would bind the wrong database.`,
    });
  } else {
    probes.push({
      name: `database ${PILOT_DATABASE_NAME}`,
      state: 'PASS',
      detail: 'exists with the id the config binds',
    });
  }

  // A Worker whose presence cannot be confirmed is not "probably fine" **before a
  // deploy**: a deployment into an unknown target is how code lands somewhere
  // nobody chose, and this repository has already had one of those. For the other
  // purposes the Worker is not the thing being changed — a backup or a migration
  // only needs the database — so an unreadable Worker is a note, not a refusal.
  const purpose = facts.purpose ?? 'deploy';
  const deploying = purpose === 'deploy';

  probes.push(
    facts.worker.state === 'present'
      ? { name: `worker ${PILOT_WORKER_NAME}`, state: 'PASS', detail: 'is deployed' }
      : facts.worker.state === 'absent'
        ? {
            name: `worker ${PILOT_WORKER_NAME}`,
            state: 'INFO',
            detail: deploying
              ? 'does not exist yet; this deploy creates it'
              : 'does not exist. That does not block this purpose, which touches the database.',
          }
        : {
            name: `worker ${PILOT_WORKER_NAME}`,
            state: deploying ? 'FAIL' : 'INFO',
            detail:
              `${facts.worker.detail} Presence could not be confirmed.` +
              (deploying
                ? ' A 403 means the token lacks Workers Scripts:Read; a 5xx means try ' +
                  'again later. Neither is permission to deploy into an unknown target.'
                : ' This purpose does not change the Worker, so it continues.'),
          },
  );

  const accessMissing = [
    facts.access.teamDomain ? null : 'ACCESS_TEAM_DOMAIN',
    facts.access.aud ? null : 'ACCESS_AUD',
  ].filter((name): name is string => name !== null);

  probes.push(
    accessMissing.length === 0
      ? {
          name: 'Access configuration present',
          state: 'PASS',
          detail: 'ACCESS_TEAM_DOMAIN and ACCESS_AUD are set (values not printed)',
        }
      : {
          name: 'Access configuration present',
          state: 'FAIL',
          detail:
            `${accessMissing.join(' and ')} empty. ` +
            '`pnpm deploy:preview` refuses to deploy without them, because a Worker ' +
            'with no verifier refuses every request.',
        },
  );

  // Present is not the same as matching. A GitHub secret being non-empty says
  // nothing about what the remote Worker holds, and the two are set in different
  // places: the secret is what a deploy passes, the Worker secret is what the
  // deployed Worker verifies against. They can disagree, and then every request is
  // refused while this preflight is green.
  probes.push({
    name: 'Access configuration matched',
    state: 'INFO',
    detail:
      'NOT CHECKED. A non-empty GitHub secret does not prove the deployed Worker holds ' +
      'the same ACCESS_TEAM_DOMAIN and ACCESS_AUD: those are Worker secrets, set ' +
      'separately. Run `wrangler secret list --name ' +
      `${PILOT_WORKER_NAME}` +
      '` to see the names, and confirm a real login — see docs/PILOT-GATES.md.',
  });

  const bucketName = facts.bucketName ?? BACKUP_BUCKET_NAME;
  if (purpose === 'backup' || purpose === 'migrate') {
    if (facts.r2 === undefined) {
      probes.push({
        name: `bucket ${bucketName}`,
        state: 'FAIL',
        detail:
          'the backup bucket was not checked. This run needs it, and an unasked ' +
          'question is a refusal rather than a pass.',
      });
    } else {
      const r2 = facts.r2;
      probes.push(
        r2.bucket === 'present'
          ? { name: `bucket ${bucketName}`, state: 'PASS', detail: 'exists and is readable' }
          : {
              name: `bucket ${bucketName}`,
              state: 'FAIL',
              detail:
                r2.bucket === 'missing'
                  ? `${r2.detail} Create it only after the owner has approved the cost ` +
                    '(docs/R2-BACKUP-DESIGN.md). Nothing here creates it.'
                  : `${r2.detail} The bucket could not be verified, so there is nowhere ` +
                    'known to put a backup.',
            },
      );

      probes.push(
        r2.publicAccess === 'none'
          ? { name: 'bucket is private', state: 'PASS', detail: 'no r2.dev domain, no custom domain' }
          : {
              name: 'bucket is private',
              state: 'FAIL',
              detail:
                r2.publicAccess === 'enabled'
                  ? `${r2.publicDetail} A public bucket holding a pilot export is a data ` +
                    'breach, not a configuration preference.'
                  : `${r2.publicDetail} Public access could not be ruled out, so the ` +
                    'backup path is refused.',
            },
      );

      const prefix = exportPrefix();
      const receiptPrefix = 'receipts/';
      const retentionPrefixes = r2.retentionPrefixes ?? [];
      const lockPrefixes = r2.lockPrefixes ?? [];

      // Retention has to apply to the prefix backups are written under. A rule on
      // some other prefix is a retention decision about other objects.
      const coveringExpiry = retentionPrefixes.some((entry) => prefixCovers(entry, prefix));
      probes.push(
        r2.retentionDays !== null && r2.retentionDays >= PROPOSED_RETENTION_DAYS && coveringExpiry
          ? {
              name: 'bucket retention',
              state: 'PASS',
              detail: `${r2.retentionDays}-day expiry rule covers ${prefix}`,
            }
          : {
              name: 'bucket retention',
              state: 'FAIL',
              detail:
                r2.retentionDays === null
                  ? `${r2.retentionDetail} No expiry rule means backups accumulate forever, ` +
                    'which is a retention decision nobody made.'
                  : !coveringExpiry
                    ? `${r2.retentionDetail} The expiry rules are scoped to ` +
                      `${retentionPrefixes.map((entry) => entry || '(whole bucket)').join(', ') || '(none)'}, ` +
                      `which does not cover ${prefix}. A backup written under ${prefix} would ` +
                      'never expire.'
                    : `${r2.retentionDays}-day expiry is shorter than the ` +
                      `${PROPOSED_RETENTION_DAYS} days this design proposes.`,
            },
      );

      // A lock is not a nice-to-have here: it is the only thing that stops a
      // token with write access from replacing the bytes behind a receipt that a
      // migration is about to trust. A unique key does not do it — `put` on an
      // existing key replaces the object and the listing looks unchanged — so a
      // missing or too-short lock is a FAIL and the run stops, rather than an INFO
      // line somebody scrolls past.
      const coveringLock = lockPrefixes.some((entry) => prefixCovers(entry, prefix));
      probes.push(
        r2.lockDays !== null && r2.lockDays >= PROPOSED_RETENTION_DAYS && coveringLock
          ? {
              name: 'bucket lock',
              state: 'PASS',
              detail:
                `${r2.lockDays}-day lock covers ${prefix}: a stored backup cannot be ` +
                'overwritten or deleted for that long, whatever the token is allowed to do. ' +
                'Effective retention is the longer of the lock and the expiry rule.',
            }
          : {
              name: 'bucket lock',
              state: 'FAIL',
              detail:
                r2.lockDays === null
                  ? `${r2.lockDetail} Without a lock rule, a write token can replace a stored ` +
                    'backup and a receipt would still point at the key. The run stops here.'
                  : !coveringLock
                    ? `${r2.lockDetail} The lock rules are scoped to ` +
                      `${lockPrefixes.map((entry) => entry || '(whole bucket)').join(', ') || '(none)'}, ` +
                      `which does not cover ${prefix}. A backup under ${prefix} could be replaced.`
                    : `${r2.lockDays}-day lock is shorter than the ` +
                      `${PROPOSED_RETENTION_DAYS}-day retention this design proposes.`,
            },
      );

      // The receipts live outside the export prefix on purpose: they are the audit
      // trail of what was stored, and expiring them would delete the evidence while
      // the object still exists. If a rule expires the whole bucket, that is worth
      // saying rather than discovering a year later.
      const receiptsExpire = retentionPrefixes.some((entry) => prefixCovers(entry, receiptPrefix));
      probes.push({
        name: 'receipts excluded from expiry',
        state: receiptsExpire ? 'INFO' : 'PASS',
        detail: receiptsExpire
          ? `an expiry rule covers ${receiptPrefix}, so receipts are deleted with the exports. ` +
            'They hold identifiers and hashes rather than customer data, and keeping them is ' +
            'what makes an old backup auditable; scope the expiry to the export prefix instead.'
          : `no expiry rule covers ${receiptPrefix}, so receipts outlive the exports they describe.`,
      });
    }
  }

  return probes;
}

/**
 * Two questions that are often written as one, and are not.
 *
 * `resources` is what this file answered. `login` is whether a person can
 * actually sign in through Access and save a record — and nothing a machine does
 * here proves it. A run that reports "preflight passed" without saying which of
 * the two it means invites the reader to conclude the pilot is usable.
 */
export function summarise(facts: PreflightFacts, probes: readonly Probe[]): string[] {
  const failures = probes.filter((probe) => probe.state === 'FAIL').length;
  const purpose = facts.purpose ?? 'deploy';
  return [
    failures === 0
      ? `RESOURCE PREFLIGHT PASSED for purpose "${purpose}".`
      : `RESOURCE PREFLIGHT FAILED: ${failures} check(s) did not pass.`,
    'ACCESS LOGIN NOT VERIFIED: no request in this run authenticated as a person.',
    'The readiness of the application, a real sign-in and a save that survives a reload',
    'are separate gate(s) — see docs/PILOT-GATES.md and docs/DEPLOY-VIA-GITHUB.md.',
  ];
}
