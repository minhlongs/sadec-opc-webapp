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

/**
 * One lifecycle rule, with the prefix it is scoped to and the age it enforces kept
 * together.
 *
 * They have to stay together. Reading "the longest age" into one field and "the
 * prefixes" into another lets a 30-day rule for `other/` answer a question about
 * `pilot/`, which is a preflight that passes while the export prefix retains for
 * seven days. Nothing in this file keeps those two facts apart again.
 */
export interface ExpiryRule {
  readonly id: string | null;
  /** `null` when the rule states a prefix that is not a string: scope unknown. */
  readonly prefix: string | null;
  readonly enabled: boolean;
  /** Days after which matching objects are deleted; `null` when it does not delete. */
  readonly days: number | null;
  /** The rule deletes objects but its age could not be read. */
  readonly unreadable: boolean;
}

/** One bucket lock rule, in the same shape for the same reason. */
export interface LockRule {
  readonly id: string | null;
  readonly prefix: string | null;
  readonly enabled: boolean;
  /** Days an object under the prefix stays undeletable and un-overwritable. */
  readonly days: number | null;
  readonly unreadable: boolean;
}

function ruleId(rule: Record<string, unknown>): string | null {
  const id = rule.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** A prefix, `null` when the rule answered with something that is not a string. */
function rulePrefix(rule: Record<string, unknown>): string | null {
  if (typeof rule.prefix === 'string') return rule.prefix;
  const conditions = rule.conditions;
  if (conditions !== null && typeof conditions === 'object') {
    const nested = (conditions as Record<string, unknown>).prefix;
    if (typeof nested === 'string') return nested;
    if (nested === undefined) return '';
  }
  if (rule.prefix === undefined && conditions === undefined) return '';
  return null;
}

/** A positive number of **days**, as `deleteObjectsAfterDays` states it. */
function positiveDays(days: unknown): number | null {
  const value = Number(days);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** A positive number of **seconds**, as a lock's or a transition's age states it. */
function positiveSecondsAsDays(seconds: unknown): number | null {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? value / 86_400 : null;
}

function rulesOf(result: unknown): Record<string, unknown>[] {
  const rules = (result as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) return [];
  return rules.filter((rule): rule is Record<string, unknown> =>
    rule !== null && typeof rule === 'object' && !Array.isArray(rule),
  );
}

/**
 * The lifecycle configuration, read rule by rule.
 *
 * Two shapes are accepted because both are in use: the flat
 * `{ prefix, deleteObjectsAfterDays }` and the nested
 * `{ conditions: { prefix }, deleteObjectsTransition: { condition: { type: 'Age',
 * maxAge | maxAgeSeconds } } }`. A rule that carries no deletion transition at all — an
 * abort-multipart rule, for instance — is not an expiry rule and is kept with
 * `days: null, unreadable: false`; a rule that deletes but whose age cannot be read
 * is marked `unreadable`, because "it expires, at some age" is not an answer this
 * preflight may treat as absent.
 */
export function readExpiryRules(result: unknown): ExpiryRule[] {
  return rulesOf(result).map((rule) => {
    const enabled = rule.enabled !== false;
    const prefix = rulePrefix(rule);
    if (rule.deleteObjectsAfterDays !== undefined) {
      const days = positiveDays(rule.deleteObjectsAfterDays);
      return { id: ruleId(rule), prefix, enabled, days, unreadable: days === null };
    }
    const transition = rule.deleteObjectsTransition;
    if (transition === undefined) {
      return { id: ruleId(rule), prefix, enabled, days: null, unreadable: false };
    }
    const condition = (transition as { condition?: unknown } | null)?.condition as
      | Record<string, unknown>
      | undefined;
    const type = condition?.type;
    if (type !== undefined && type !== 'Age') {
      return { id: ruleId(rule), prefix, enabled, days: null, unreadable: true };
    }
    const days = positiveSecondsAsDays(condition?.maxAgeSeconds ?? condition?.maxAge);
    return { id: ruleId(rule), prefix, enabled, days, unreadable: days === null };
  });
}

/** The bucket lock configuration, read rule by rule. */
export function readLockRules(result: unknown): LockRule[] {
  return rulesOf(result).map((rule) => {
    const enabled = rule.enabled !== false;
    const prefix = rulePrefix(rule);
    const condition = (rule.condition ?? (rule.conditions as Record<string, unknown> | undefined)
      ?.condition) as Record<string, unknown> | undefined;
    const encoded = condition?.maxAgeSeconds ?? (rule.conditions as Record<string, unknown> | undefined)?.maxAgeSeconds;
    const days = positiveSecondsAsDays(encoded);
    return { id: ruleId(rule), prefix, enabled, days, unreadable: days === null };
  });
}

/** A rule that is in force for the target, with the value it contributes. */
export interface ApplyingRule {
  readonly id: string | null;
  readonly prefix: string;
  readonly days: number | null;
}

/**
 * What actually applies to one prefix, and why.
 *
 * The two kinds of rule do not combine the same way, which is the reason this is
 * a function per kind rather than one shared "max":
 *
 * - **Expiry** deletes an object when the first matching rule comes due, so the
 *   value in force is the *earliest* (smallest) age among the rules that cover the
 *   prefix. A longer rule for the same prefix cannot rescue a shorter one.
 * - **Lock** protects an object while *any* matching rule says it is still young,
 *   so the value in force is the *latest* (largest) age among them.
 *
 * A rule scoped to a prefix that does not cover the target contributes nothing
 * here, whatever its number is. A covering rule that is disabled contributes
 * nothing either, but is reported so the refusal can say "the rule exists and is
 * off" rather than "there is no rule". A covering rule whose age or scope could not
 * be read makes the answer unknown, and `unknown` is reported as such.
 */
export interface RuleReading {
  readonly covering: readonly ApplyingRule[];
  readonly disabled: readonly ApplyingRule[];
  /** Covering, enabled rules whose scope or age could not be read. */
  readonly unreadable: readonly { readonly id: string | null; readonly scope: string }[];
  /** The value in force for the target: earliest expiry, latest lock. */
  readonly days: number | null;
  /** The longest age among rules that do *not* cover the target, for the message. */
  readonly elsewhere: ApplyingRule | null;
}

function readRules(
  rules: readonly {
    id: string | null;
    prefix: string | null;
    enabled: boolean;
    days: number | null;
    unreadable: boolean;
  }[],
  target: string,
  kind: 'expiry' | 'lock',
): RuleReading {
  const covering: ApplyingRule[] = [];
  const disabled: ApplyingRule[] = [];
  const unreadable: { id: string | null; scope: string }[] = [];
  let elsewhere: ApplyingRule | null = null;

  for (const rule of rules) {
    // A lifecycle rule with no deletion transition is not an expiry rule at all —
    // an abort-multipart rule, say — so it is neither in force nor a candidate.
    // Counting it would refuse a bucket that also uses lifecycle for cleanup that
    // has nothing to do with retention. Writing "days: null, unreadable: false" is
    // how `readExpiryRules` says exactly that.
    if (kind === 'expiry' && rule.days === null && !rule.unreadable) continue;

    const covers = rule.prefix === null || prefixCovers(rule.prefix, target);
    if (!covers) {
      const prefix = rule.prefix as string;
      if (rule.enabled && rule.days !== null) {
        if (elsewhere === null || rule.days > (elsewhere.days ?? 0)) {
          elsewhere = { id: rule.id, prefix, days: rule.days };
        }
      }
      continue;
    }
    if (rule.prefix === null) {
      // The scope could not be read, so whether it covers the target is unknown.
      // An unknown scope is treated as covering and as unreadable, which refuses.
      unreadable.push({ id: rule.id, scope: '(unreadable scope)' });
      continue;
    }
    const entry: ApplyingRule = { id: rule.id, prefix: rule.prefix, days: rule.days };
    if (!rule.enabled) {
      // Off is not protection, but it is worth naming: "the rule exists and is
      // disabled" is a different instruction from "there is no rule".
      disabled.push(entry);
      continue;
    }
    if (rule.unreadable || rule.days === null) {
      unreadable.push({ id: rule.id, scope: rule.prefix === '' ? '(whole bucket)' : rule.prefix });
      continue;
    }
    covering.push(entry);
  }

  const values = covering.map((rule) => rule.days as number);
  const days =
    values.length === 0 ? null : kind === 'expiry' ? Math.min(...values) : Math.max(...values);
  return { covering, disabled, unreadable, days, elsewhere };
}

/** Expiry in force for `target`: the earliest age among the rules that cover it. */
export function effectiveExpiry(rules: readonly ExpiryRule[], target: string): RuleReading {
  return readRules(rules, target, 'expiry');
}

/** Lock in force for `target`: the latest age among the rules that cover it. */
export function effectiveLock(rules: readonly LockRule[], target: string): RuleReading {
  return readRules(rules, target, 'lock');
}

export interface R2Facts {
  /** `unknown` when the bucket could not be read at all: absent is `missing`. */
  readonly bucket: 'present' | 'missing' | 'unknown';
  readonly detail: string;
  /** A managed `r2.dev` domain or any custom domain makes the bucket public. */
  readonly publicAccess: 'none' | 'enabled' | 'unknown';
  readonly publicDetail: string;
  /** Every lifecycle rule, each still carrying its own prefix and age. */
  readonly lifecycle: R2RuleSet<ExpiryRule>;
  /** Every bucket lock rule, each still carrying its own prefix and age. */
  readonly lock: R2RuleSet<LockRule>;
}

export interface R2RuleSet<T> {
  readonly readable: boolean;
  /** What the API answered, for a refusal to repeat. */
  readonly detail: string;
  readonly rules: readonly T[];
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

/** ` (rule a, rule b)` naming the rules whose age was used, when there are any. */
function describeRule(reading: RuleReading): string {
  const names = reading.covering
    .map((rule) => rule.id ?? (rule.prefix === '' ? '(whole bucket)' : rule.prefix))
    .join(', ');
  return names === '' ? '' : ` (${names})`;
}

/**
 * Why a retention or lock question cannot be answered affirmatively, or `null`
 * when the only question left is the number itself.
 *
 * Every refusal names the rule or the permission that decided it. A refusal that
 * says only "the rules are on other prefixes" makes the next reader open the
 * dashboard and conclude the check is broken; one that names the 30-day rule on
 * `other/` and says it does not apply here cannot be misread that way.
 */
function refusalReason(
  reading: RuleReading,
  source: { readonly readable: boolean; readonly detail: string; readonly rules: readonly unknown[] },
  target: string,
  kind: 'expiry' | 'lock',
): string | null {
  const noun = kind === 'expiry' ? 'lifecycle' : 'lock';
  if (!source.readable) {
    return `${source.detail} The ${noun} configuration could not be read, and an unread answer is a refusal.`;
  }
  if (reading.unreadable.length > 0) {
    const named = reading.unreadable
      .map((rule) => (rule.id === null ? rule.scope : `rule ${rule.id} on ${rule.scope}`))
      .join(', ');
    return (
      `a ${noun} rule covers ${target} but its ${kind === 'expiry' ? 'age' : 'duration'} could not ` +
      `be read (${named}). The preflight will not guess: fix the rule, or the token's R2 read ` +
      'permission, and run again.'
    );
  }
  if (reading.covering.length === 0) {
    const off = reading.disabled.length
      ? ` A rule for ${reading.disabled
          .map((rule) => (rule.prefix === '' ? '(whole bucket)' : rule.prefix))
          .join(', ')} exists but is disabled, so it enforces nothing.`
      : '';
    const elsewhere = reading.elsewhere
      ? ` The longest rule elsewhere is ${reading.elsewhere.days} days on ` +
        `${reading.elsewhere.prefix === '' ? '(whole bucket)' : reading.elsewhere.prefix}, ` +
        'which does not apply to this prefix.'
      : '';
    return (
      `no enabled ${noun} rule applies to ${target}.${off}${elsewhere} ` +
      `A rule for another prefix is not ${kind === 'expiry' ? 'retention' : 'protection'} for this one.`
    );
  }
  return null;
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
  const accessRequired = purpose === 'deploy' || purpose === 'bootstrap';

  probes.push(
    accessMissing.length === 0
      ? {
          name: 'Access configuration present',
          state: 'PASS',
          detail: 'ACCESS_TEAM_DOMAIN and ACCESS_AUD are set (values not printed)',
        }
      : {
          name: 'Access configuration present',
          state: accessRequired ? 'FAIL' : 'INFO',
          detail: accessRequired
            ? `${accessMissing.join(' and ')} empty. ` +
              '`pnpm deploy:preview` refuses to deploy without them, because a Worker ' +
              'with no verifier refuses every request.'
            : `${accessMissing.join(' and ')} empty. ` +
              'This purpose touches the database or backup bucket rather than the Worker verifier, ' +
              'so missing Access configuration is reported as information; `deploy` and `bootstrap` still refuse.',
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

      // Retention has to apply to the prefix backups are written under, and the
      // number that counts is the one in the rule that applies there. `pilot/`
      // expiring at 7 days is not made 30 days by a 30-day rule on `other/`.
      const expiry = effectiveExpiry(r2.lifecycle.rules, prefix);
      const expiryReason = refusalReason(expiry, r2.lifecycle, prefix, 'expiry');
      probes.push(
        expiry.days !== null && expiry.unreadable.length === 0 && expiry.days >= PROPOSED_RETENTION_DAYS
          ? {
              name: 'bucket retention',
              state: 'PASS',
              detail:
                `${expiry.days}-day expiry applies to ${prefix}` +
                describeRule(expiry) +
                '. Backups written under this prefix are deleted after that long.',
            }
          : {
              name: 'bucket retention',
              state: 'FAIL',
              detail:
                expiryReason ??
                `${expiry.days}-day expiry applies to ${prefix}${describeRule(expiry)}, which is ` +
                  `shorter than the ${PROPOSED_RETENTION_DAYS} days this design proposes.`,
            },
      );

      // A lock is not a nice-to-have here: it is the only thing that stops a
      // token with write access from replacing the bytes behind a receipt that a
      // migration is about to trust. A unique key does not do it — `put` on an
      // existing key replaces the object and the listing looks unchanged — so a
      // missing or too-short lock is a FAIL and the run stops, rather than an INFO
      // line somebody scrolls past.
      const lock = effectiveLock(r2.lock.rules, prefix);
      const lockReason = refusalReason(lock, r2.lock, prefix, 'lock');
      probes.push(
        lock.days !== null && lock.unreadable.length === 0 && lock.days >= PROPOSED_RETENTION_DAYS
          ? {
              name: 'bucket lock',
              state: 'PASS',
              detail:
                `${lock.days}-day lock applies to ${prefix}${describeRule(lock)}: a stored backup ` +
                'under this prefix cannot be overwritten or deleted for that long, whatever the ' +
                'token is allowed to do.',
            }
          : {
              name: 'bucket lock',
              state: 'FAIL',
              detail: lockReason ?? `${lock.days}-day lock applies to ${prefix}${describeRule(lock)}, which is shorter than the ${PROPOSED_RETENTION_DAYS}-day retention this design proposes.`,
            },
      );

      // The receipts live outside the export prefix on purpose: they are the audit
      // trail of what was stored, and expiring them would delete the evidence while
      // the object still exists. This is asked of the same rules, not of a list of
      // prefixes: a rule counts only if it applies to `receipts/`.
      const receiptExpiry = effectiveExpiry(
        r2.lifecycle.rules.filter((rule) => rule.days !== null || rule.unreadable),
        receiptPrefix,
      );
      const receiptsExpire = receiptExpiry.covering.length > 0 || receiptExpiry.unreadable.length > 0;
      probes.push({
        name: 'receipts excluded from expiry',
        state: receiptsExpire ? 'INFO' : 'PASS',
        detail: receiptsExpire
          ? `an expiry rule covers ${receiptPrefix}${describeRule(receiptExpiry)}, so receipts are ` +
            'deleted with the exports. They hold identifiers and hashes rather than customer ' +
            'data, and keeping them is what makes an old backup auditable; scope the expiry to ' +
            'the export prefix instead.'
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
