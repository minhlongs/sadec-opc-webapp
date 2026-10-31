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

export interface PreflightFacts {
  readonly accountId: string | null;
  readonly tokenPresent: boolean;
  readonly expectedDatabaseId: string | null;
  readonly account: { readable: boolean; id: string | null; detail: string };
  readonly database: { found: boolean; id: string | null; detail: string };
  readonly worker: { state: 'present' | 'absent' | 'unknown'; detail: string };
  readonly access: { teamDomain: boolean; aud: boolean };
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

  probes.push(
    facts.worker.state === 'present'
      ? { name: `worker ${PILOT_WORKER_NAME}`, state: 'PASS', detail: 'is deployed' }
      : facts.worker.state === 'absent'
        ? {
            name: `worker ${PILOT_WORKER_NAME}`,
            state: 'INFO',
            detail: 'does not exist yet; a first deploy creates it',
          }
        : {
            name: `worker ${PILOT_WORKER_NAME}`,
            state: 'INFO',
            detail: `${facts.worker.detail} Presence could not be confirmed.`,
          },
  );

  const accessMissing = [
    facts.access.teamDomain ? null : 'ACCESS_TEAM_DOMAIN',
    facts.access.aud ? null : 'ACCESS_AUD',
  ].filter((name): name is string => name !== null);

  probes.push(
    accessMissing.length === 0
      ? {
          name: 'Access configuration',
          state: 'PASS',
          detail: 'ACCESS_TEAM_DOMAIN and ACCESS_AUD are set (values not printed)',
        }
      : {
          name: 'Access configuration',
          state: 'FAIL',
          detail:
            `${accessMissing.join(' and ')} empty. ` +
            '`pnpm deploy:preview` refuses to deploy without them, because a Worker ' +
            'with no verifier refuses every request.',
        },
  );

  return probes;
}
