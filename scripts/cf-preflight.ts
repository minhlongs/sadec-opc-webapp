#!/usr/bin/env node
/**
 * Is this token pointed at the right Cloudflare account, worker and database?
 *
 *   pnpm preflight:cloudflare
 *
 * Run before anything that writes. Every expensive and irreversible mistake in
 * this repository's deploy path has been a *wrong target*: a Worker with no
 * database binding, an `APP_ENV` that selected the demo database, a deployment
 * that succeeded and refused every request. Those were found by reading output,
 * minutes later. This asks the four questions that would have caught them, and
 * asks them with the token the deploy itself uses:
 *
 *   1. the token works, and the account it can see is the account named;
 *   2. the database called `sadec-pilot` exists, and its id is the id in
 *      `wrangler.jsonc` — not merely a database with a similar name;
 *   3. the pilot Worker exists (absent is reported, not failed: a first deploy
 *      has no Worker yet);
 *   4. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are present and non-empty;
 *   5. for a backup or a migration: the R2 bucket exists, is **not public**, keeps
 *      objects under the export prefix for the proposed retention, and **locks**
 *      them for that long. A missing lock is a failure, not a note: without it the
 *      bytes behind a receipt can be replaced by anyone holding the write token.
 *
 * `--purpose` decides which questions are asked. It defaults to `deploy`, the
 * strictest: a Worker whose presence cannot be confirmed blocks a deploy, and an
 * unasked question is never a pass.
 *
 * Read-only. It never prints the token, and never a response body: Cloudflare's
 * error objects are echoed field by field, so an unexpected payload cannot carry
 * something into a public log.
 *
 * Nothing here retries. A 403 is a missing permission and the message says which
 * operation it was for, because retrying a permission error produces the same
 * permission error and burns the operator's confidence in the check.
 */

import { readFileSync } from 'node:fs';
import {
  BACKUP_BUCKET_NAME,
  CONFIG_PATH,
  EXPECTED_ACCOUNT_ID,
  PILOT_BINDING,
  PILOT_DATABASE_NAME,
  PILOT_WORKER_NAME,
  databaseIdFor,
  evaluatePreflight,
  readExpiryRules,
  readLockRules,
  summarise,
  type PreflightFacts,
  type PreflightPurpose,
  type R2Facts,
} from './preflight-facts.ts';

// ---------------------------------------------------------------------------
// Gathering. Split from the decision above so the decision has tests offline.
// ---------------------------------------------------------------------------

const API = 'https://api.cloudflare.com/client/v4';

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value.trim();
}

const PURPOSES: readonly PreflightPurpose[] = ['deploy', 'migrate', 'backup', 'bootstrap', 'inspect'];
const requestedPurpose = flagValue('--purpose') ?? 'deploy';
if (!(PURPOSES as readonly string[]).includes(requestedPurpose)) {
  process.stderr.write(
    `\nError: --purpose "${requestedPurpose}" is not one of ${PURPOSES.join(', ')}.\n`,
  );
  process.exit(2);
}
const purpose = requestedPurpose as PreflightPurpose;
const bucketName = flagValue('--bucket') ?? BACKUP_BUCKET_NAME;

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

function describeErrors(body: unknown): string {
  const errors = (body as CfEnvelope<unknown>).errors;
  if (!Array.isArray(errors) || errors.length === 0) return 'no error object was returned';
  return errors
    .map((entry) => `${entry.code ?? '?'} ${entry.message ?? '(no message)'}`)
    .join('; ');
}

async function get<T>(path: string, token: string): Promise<{ status: number; body: CfEnvelope<T> | null }> {
  const response = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  let body: CfEnvelope<T> | null = null;
  try {
    body = (await response.json()) as CfEnvelope<T>;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function gather(): Promise<PreflightFacts> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  const accessTeamDomain = (process.env.ACCESS_TEAM_DOMAIN ?? '').trim();
  const accessAud = (process.env.ACCESS_AUD ?? '').trim();

  let expectedDatabaseId: string | null = null;
  try {
    expectedDatabaseId = databaseIdFor(readFileSync(CONFIG_PATH, 'utf8'), PILOT_BINDING);
  } catch {
    expectedDatabaseId = null;
  }

  const facts: PreflightFacts = {
    accountId: accountId === '' ? null : accountId,
    tokenPresent: token !== '',
    expectedDatabaseId,
    account: { readable: false, id: null, detail: 'not checked' },
    database: { found: false, id: null, detail: 'not checked' },
    worker: { state: 'unknown', detail: 'not checked' },
    access: { teamDomain: accessTeamDomain !== '', aud: accessAud !== '' },
  };

  // Nothing is queried with an empty token: the API answers 400/401 for that and
  // the message would be about a bad request rather than about a missing secret.
  if (token === '' || accountId === '') return facts;

  // Locals, not assignments into `facts`: the facts record is read-only, so a
  // probe cannot be overwritten by a later one and the report stays consistent
  // with what was asked.
  let accountFact = facts.account;
  let databaseFact = facts.database;
  let workerFact = facts.worker;

  const account = await get<{ id?: string; name?: string }>(`/accounts/${accountId}`, token);
  if (account.status === 200 && account.body?.success === true) {
    const id = String(account.body.result?.id ?? '');
    accountFact = {
      readable: id === accountId,
      id,
      detail:
        id === accountId
          ? `the token can read account "${String(account.body.result?.name ?? '(no name)')}"`
          : `the API returned account id ${id || '(none)'} for ${accountId}`,
    };
  } else if (account.status === 403 || account.status === 401) {
    accountFact = {
      readable: false,
      id: null,
      detail: `the API answered ${account.status} (${describeErrors(account.body)}).`,
    };
  } else {
    accountFact = {
      readable: false,
      id: null,
      detail: `the API answered ${account.status} (${describeErrors(account.body)}).`,
    };
  }

  const databases = await get<{ uuid?: string; id?: string; name?: string }[]>(
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(PILOT_DATABASE_NAME)}&per_page=10`,
    token,
  );
  if (databases.status === 200 && databases.body?.success === true) {
    const rows = databases.body.result ?? [];
    const match = rows.find((row) => row.name === PILOT_DATABASE_NAME) ?? null;
    databaseFact = match
      ? { found: true, id: String(match.uuid ?? match.id ?? ''), detail: '' }
      : {
          found: false,
          id: null,
          detail:
            `no database named ${PILOT_DATABASE_NAME} is visible to this token ` +
            `(${rows.length} returned by the filter). The token needs D1:Read on the account.`,
        };
  } else {
    databaseFact = {
      found: false,
      id: null,
      detail:
        `listing D1 databases answered ${databases.status} (${describeErrors(databases.body)}). ` +
        'D1:Read is what this step needs; D1:Edit is what a migration needs.',
    };
  }

  const worker = await get<unknown>(`/accounts/${accountId}/workers/scripts/${PILOT_WORKER_NAME}`, token);
  if (worker.status === 200) {
    workerFact = { state: 'present', detail: '' };
  } else if (worker.status === 404) {
    workerFact = { state: 'absent', detail: '' };
  } else {
    workerFact = {
      state: 'unknown',
      detail: `the API answered ${worker.status} (${describeErrors(worker.body)}).`,
    };
  }

  let r2: R2Facts | undefined;
  if (purpose === 'backup' || purpose === 'migrate') {
    r2 = await gatherR2(accountId, bucketName, token);
  }

  return {
    ...facts,
    account: accountFact,
    database: databaseFact,
    worker: workerFact,
    purpose,
    bucketName,
    ...(r2 === undefined ? {} : { r2 }),
  };
}

/**
 * The bucket's own configuration: does it exist, is it private, and does it keep
 * what it is given for long enough.
 *
 * Every failure mode is a distinct answer because the operator's next action
 * differs: a 404 means the bucket was never created (a cost decision), a 403 means
 * the token cannot see R2 configuration (a permission), and anything else means
 * the answer is unknown, which for a backup is a refusal.
 */
async function gatherR2(accountId: string, bucket: string, token: string): Promise<R2Facts> {
  const base = `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`;
  const bucketResult = await get<unknown>(base, token);

  if (bucketResult.status === 404) {
    return {
      bucket: 'missing',
      detail: `no bucket named ${bucket} is visible to this token.`,
      publicAccess: 'unknown',
      publicDetail: 'not checked',
      lifecycle: { readable: false, detail: 'not checked: the bucket itself was missing.', rules: [] },
      lock: { readable: false, detail: 'not checked: the bucket itself was missing.', rules: [] },
    };
  }
  if (bucketResult.status !== 200) {
    return {
      bucket: 'unknown',
      detail:
        `reading the bucket answered ${bucketResult.status} ` +
        `(${describeErrors(bucketResult.body)}). Workers R2 Storage Read is what this needs.`,
      publicAccess: 'unknown',
      publicDetail: 'not checked',
      lifecycle: { readable: false, detail: 'not checked: the bucket itself was unreadable.', rules: [] },
      lock: { readable: false, detail: 'not checked: the bucket itself was unreadable.', rules: [] },
    };
  }

  // Public access has two separate switches and neither may be on: a managed
  // r2.dev domain, and any custom domain.
  const managed = await get<{ enabled?: boolean }>(`${base}/domains/managed`, token);
  const custom = await get<{ domains?: unknown[] }>(`${base}/domains/custom`, token);
  let publicAccess: R2Facts['publicAccess'] = 'none';
  let publicDetail = 'no managed domain is enabled';
  if (managed.status !== 200 || custom.status !== 200) {
    publicAccess = 'unknown';
    publicDetail =
      `reading the bucket's domains answered ${managed.status}/${custom.status}, so public ` +
      'access could not be ruled out.';
  } else if (managed.body?.result?.enabled === true) {
    publicAccess = 'enabled';
    publicDetail = 'the managed r2.dev domain is enabled, so objects are reachable over HTTP.';
  } else if (Array.isArray(custom.body?.result?.domains) && custom.body.result.domains.length > 0) {
    publicAccess = 'enabled';
    publicDetail = `${custom.body.result.domains.length} custom domain(s) are attached to the bucket.`;
  }

  // The rules are read one at a time and handed on with their own prefix, state
  // and age attached. Summarising them here — the longest age in one field, the
  // prefixes in another — is what let a 30-day rule on `other/` answer for
  // `pilot/`; the decision is in `preflight-facts.ts` and needs the rules intact.
  const lifecycle = await get<unknown>(`${base}/lifecycle`, token);
  const lifecycleRules =
    lifecycle.status === 200 && lifecycle.body?.success === true
      ? readExpiryRules(lifecycle.body.result)
      : [];
  const lifecycleState = {
    readable: lifecycle.status === 200 && lifecycle.body?.success === true,
    detail:
      lifecycle.status === 200 && lifecycle.body?.success === true
        ? `the lifecycle configuration lists ${lifecycleRules.length} rule(s).`
        : `reading the lifecycle answered ${lifecycle.status} (${describeErrors(lifecycle.body)}).`,
    rules: lifecycleRules,
  };

  const lock = await get<unknown>(`${base}/lock`, token);
  const lockRules =
    lock.status === 200 && lock.body?.success === true ? readLockRules(lock.body.result) : [];
  const lockState = {
    readable: lock.status === 200 && lock.body?.success === true,
    detail:
      lock.status === 200 && lock.body?.success === true
        ? `the lock configuration lists ${lockRules.length} rule(s).`
        : `reading the bucket lock answered ${lock.status} (${describeErrors(lock.body)}).`,
    rules: lockRules,
  };

  return {
    bucket: 'present',
    detail: '',
    publicAccess,
    publicDetail,
    lifecycle: lifecycleState,
    lock: lockState,
  };
}

const facts = await gather();
const probes = evaluatePreflight(facts);

const accountLabel = facts.accountId === null ? '(unset)' : facts.accountId;
process.stdout.write(
  `Cloudflare preflight (purpose: ${purpose})\n` +
    `Account:  ${accountLabel}\n` +
    `Database: ${PILOT_DATABASE_NAME} (binding ${PILOT_BINDING})\n` +
    `Worker:   ${PILOT_WORKER_NAME}\n` +
    (purpose === 'backup' || purpose === 'migrate' ? `Bucket:   ${bucketName}\n` : '') +
    '\n',
);

for (const probe of probes) {
  process.stdout.write(`${probe.state.padEnd(4)}  ${probe.name}: ${probe.detail}\n`);
}

for (const line of summarise(facts, probes)) process.stdout.write(`${line}\n`);

const failed = probes.filter((probe) => probe.state === 'FAIL');
if (failed.length > 0) {
  process.stdout.write(
    `\nPreflight failed on ${failed.length} check(s). Nothing was changed: this command is read-only.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  '\nThe resource questions passed. They say nothing about whether a person can sign in.\n',
);
