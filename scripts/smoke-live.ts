#!/usr/bin/env node
/**
 * The unauthenticated half of a live check, as one command.
 *
 * Why this exists: `docs/PILOT-RUNBOOK.md` §7 asks for a dozen `curl` calls whose
 * outputs a person then has to read and compare by eye. Reading them by eye is
 * how "401 because the Worker is alive and refusing correctly" gets confused with
 * "401 because the deployment is broken", and how a `200` carrying an error body
 * gets waved through. This script asks the same questions, states what each
 * answer means, and exits non-zero when one is wrong.
 *
 * What it deliberately does **not** do:
 *
 *   - It never authenticates. There is no `--token`, no cookie jar and no login
 *     step. A check that needs an identity is a check somebody must perform in a
 *     browser as themselves; asking for a JWT here would put one in a shell
 *     history, a terminal buffer and a chat log to prove something a person can
 *     see for themselves. The authenticated checks stay in the runbook.
 *   - It writes nothing to the target. Every request is a GET, or a POST that is
 *     expected to be refused *before* any handler runs (the authorization
 *     chokepoint answers 401 first). It creates no booking, no receipt and no
 *     lot, so it needs no smoke workspace and leaves no rows.
 *   - It asserts nothing about money. There is no payment integration, and a
 *     script that claimed one was working would be lying.
 *
 * The target is required and printed. `localhost` is accepted only with
 * `--local`, and the summary then says in the first line that a local run is not
 * evidence about a deployment — because the one way this script could mislead is
 * if a green local run were pasted into a release note as a live result.
 */

import { exit } from 'node:process';

/** One check's outcome, kept as data so the summary and the test read the same thing. */
interface CheckResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'INFO';
  detail: string;
}

const results: CheckResult[] = [];

/**
 * The environment the Worker said it is in, once `/api/health` has answered.
 *
 * The identity checks below only mean something where the development adapter is
 * off, and that adapter is selected by `APP_ENV` — not by the host. So the
 * Worker's own answer decides whether those checks are assertions or notes. On a
 * deployment a wrong value is already a hard failure in `checkHealth`, which is
 * what stops this from becoming a way to skip them.
 */
let reportedEnv: string | null = null;

/** Environments in which the local identity adapter is permitted to exist. */
const DEVELOPMENT_ENVS = new Set(['local', 'test', 'development']);

function pass(name: string, detail: string): void {
  results.push({ name, status: 'PASS', detail });
}

function fail(name: string, detail: string): void {
  results.push({ name, status: 'FAIL', detail });
}

function info(name: string, detail: string): void {
  results.push({ name, status: 'INFO', detail });
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

const baseUrl = flagValue('--base-url');
const allowLocal = process.argv.includes('--local');

if (baseUrl === null) {
  process.stderr.write(
    'Usage: pnpm smoke:live -- --base-url https://sadec-flow-pilot.<account>.workers.dev\n\n' +
      'Add --local when the target is http://localhost (a developer check, not a\n' +
      'deployment check). The target is printed either way.\n',
  );
  exit(2);
}

let origin: string;
try {
  origin = new URL(baseUrl).origin;
} catch {
  process.stderr.write(`Not a URL: ${baseUrl}\n`);
  exit(2);
}

const isLocalTarget = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(origin).hostname);
if (isLocalTarget && !allowLocal) {
  process.stderr.write(
    `\nRefusing to smoke-test ${origin} without --local.\n\n` +
      'A green run against a developer server is not evidence about a deployment,\n' +
      'and the easiest way to get that wrong is to point this at localhost and\n' +
      'write the result into a release note. Pass --local to say you know.\n',
  );
  exit(2);
}

process.stdout.write(
  `Target:  ${origin}\n` +
    (isLocalTarget
      ? 'Scope:   LOCAL — this is a developer check, NOT a deployment check.\n'
      : 'Scope:   REMOTE — read-only, unauthenticated surface only.\n') +
    '\n',
);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface Answer {
  status: number;
  headers: Headers;
  body: string;
  /** Parsed JSON when the body is JSON, otherwise null. Never throws. */
  json: unknown;
  /** True when a `fetch` itself failed, which is a connection problem. */
  unreachable: boolean;
  error: string | null;
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Answer> {
  try {
    const response = await fetch(`${origin}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        // A browser-shaped request. `Sec-Fetch-Site` is what the Worker checks on
        // a mutation; without it every POST is refused for the wrong reason and
        // the check proves nothing about authorization.
        'sec-fetch-site': 'same-origin',
        ...(init.headers ?? {}),
      },
    });
    const body = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return {
      status: response.status,
      headers: response.headers,
      body,
      json,
      unreachable: false,
      error: null,
    };
  } catch (thrown) {
    return {
      status: 0,
      headers: new Headers(),
      body: '',
      json: null,
      unreachable: true,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

function codeOf(answer: Answer): string | null {
  if (typeof answer.json !== 'object' || answer.json === null) return null;
  const code = (answer.json as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** A short, quotable form of a body, for a failure message. */
function snippet(answer: Answer, limit = 90): string {
  const text = answer.body.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * The Worker is alive, and it says which environment it thinks it is.
 *
 * `env` matters more than `status`: a deployment whose `APP_ENV` is `local` or
 * empty would serve the demo identity path, and that is the single most
 * dangerous misconfiguration this project has (it makes a pilot reachable
 * without Access). On a remote target it is a failure, not a warning.
 */
async function checkHealth(): Promise<void> {
  const answer = await request('/api/health');
  if (answer.unreachable) {
    return fail('health', `could not connect: ${answer.error}`);
  }
  if (answer.status !== 200) {
    return fail('health', `expected 200, got ${answer.status}: ${snippet(answer)}`);
  }
  const body = answer.json as { status?: unknown; env?: unknown } | null;
  if (body === null || body.status !== 'ok') {
    return fail('health', `expected {"status":"ok"}, got ${snippet(answer)}`);
  }
  const env = typeof body.env === 'string' ? body.env : '';
  reportedEnv = env;
  if (!isLocalTarget && env !== 'pilot' && env !== 'demo') {
    return fail(
      'health',
      `the Worker reports env="${env}" on a remote host; a deployment must report pilot or demo, ` +
        'otherwise APP_ENV is unset and the local identity path may be active',
    );
  }
  pass('health', `200, status=ok, env="${env}"`);
}

/**
 * The catalogue, where "unavailable" must not look like "empty".
 *
 * Two answers are correct and they mean opposite things: `200` with a `lots`
 * array (empty is a real answer — nothing is published) and `503` with
 * `code: "catalog_unavailable"` and `cache-control: no-store` (the read failed).
 * A `200` carrying an error body is the failure this project already fixed once,
 * so it is a hard fail here rather than a warning.
 */
async function checkCatalog(): Promise<void> {
  const answer = await request('/api/public/catalog');
  if (answer.unreachable) {
    return fail('catalog', `could not connect: ${answer.error}`);
  }

  if (answer.status === 503) {
    const code = codeOf(answer);
    if (code !== 'catalog_unavailable') {
      return fail('catalog', `503 without code=catalog_unavailable: ${snippet(answer)}`);
    }
    const cache = answer.headers.get('cache-control') ?? '';
    if (!cache.includes('no-store')) {
      return fail('catalog', `503 is cacheable (cache-control: "${cache}"); an outage would be cached`);
    }
    return pass('catalog', '503 catalog_unavailable, no-store — the database could not be read');
  }

  if (answer.status !== 200) {
    return fail('catalog', `expected 200 or 503, got ${answer.status}: ${snippet(answer)}`);
  }
  const body = answer.json as { lots?: unknown; error?: unknown } | null;
  if (body === null) {
    return fail('catalog', `200 with a non-JSON body: ${snippet(answer)}`);
  }
  if (body.error !== undefined) {
    return fail('catalog', `200 carrying an error — this is the "unavailable looks empty" defect: ${snippet(answer)}`);
  }
  if (!Array.isArray(body.lots)) {
    return fail('catalog', `200 without a lots array: ${snippet(answer)}`);
  }
  pass(
    'catalog',
    body.lots.length === 0
      ? '200, lots: [] — nothing is published (a real answer, distinct from a failed read)'
      : `200, ${body.lots.length} published lot(s)`,
  );
}

/** The machine-readable surface. Describes the service and reads no data. */
async function checkSchema(): Promise<void> {
  const answer = await request('/api/schema');
  if (answer.unreachable) return fail('schema', `could not connect: ${answer.error}`);
  if (answer.status !== 200) return fail('schema', `expected 200, got ${answer.status}`);
  if (answer.json === null) return fail('schema', 'expected JSON, got a non-JSON body');
  pass('schema', '200, JSON');
}

/** The human/agent discovery page, same unavailable-vs-empty rule as the catalogue. */
async function checkDiscover(): Promise<void> {
  const answer = await request('/api/discover');
  if (answer.unreachable) return fail('discover', `could not connect: ${answer.error}`);
  if (answer.status === 200) {
    const type = answer.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) {
      return fail('discover', `200 with content-type "${type}"`);
    }
    return pass('discover', '200, HTML');
  }
  if (answer.status === 503) {
    return pass('discover', '503 — the database could not be read (correct: it refuses to invent a page)');
  }
  fail('discover', `expected 200 or 503, got ${answer.status}`);
}

/**
 * No credential, a forged bearer, and the old development header.
 *
 * All three must be `401`. The third is the one worth spelling out: `X-Dev-Identity`
 * has no code path on a deployment — the local identity adapter is selected by
 * `APP_ENV`, not by the request — so a `200` here would mean the Worker is
 * running with a local environment and is reachable without Access.
 */
async function checkIdentityRefusals(): Promise<void> {
  if (reportedEnv !== null && DEVELOPMENT_ENVS.has(reportedEnv)) {
    // Locally the Worker authenticates the labelled demo identity by design, so
    // "an anonymous request is refused" is not true here and asserting it would
    // report a correct deployment as broken. It is skipped with the reason, not
    // silently dropped.
    return info(
      'identity checks',
      `skipped: the Worker reports env="${reportedEnv}", where the labelled demo identity signs in by design`,
    );
  }

  const anonymous = await request('/api/session');
  if (anonymous.unreachable) return fail('session/anonymous', `could not connect: ${anonymous.error}`);
  if (anonymous.status === 200) {
    return fail('session/anonymous', '200 without any credential — the Worker is authenticating nobody');
  }
  if (anonymous.status !== 401) {
    return fail('session/anonymous', `expected 401, got ${anonymous.status}: ${snippet(anonymous)}`);
  }
  pass('session/anonymous', '401 — no credential, refused');

  const forged = await request('/api/session', {
    headers: { authorization: 'Bearer not-a-real-access-token' },
  });
  if (forged.status !== 401) {
    return fail('session/forged-JWT', `expected 401, got ${forged.status}: ${snippet(forged)}`);
  }
  pass('session/forged-JWT', '401 — an unsigned token is refused');

  const devHeader = await request('/api/session', {
    headers: { 'x-dev-identity': 'demo-admin' },
  });
  if (devHeader.status !== 401) {
    return fail(
      'session/dev-identity',
      `expected 401, got ${devHeader.status} — the development identity is reachable on this target`,
    );
  }
  pass('session/dev-identity', '401 — the development identity does not exist here');

  const guardedRead = await request('/api/products', {
    headers: { authorization: 'Bearer not-a-real-access-token' },
  });
  if (guardedRead.status !== 401) {
    return fail('guarded read', `expected 401 on /api/products, got ${guardedRead.status}`);
  }
  pass('guarded read', '401 — a guarded read is refused before any handler');

  const guardedWrite = await request('/api/quote-drafts/save', {
    method: 'POST',
    headers: { authorization: 'Bearer not-a-real-access-token', 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (guardedWrite.status !== 401) {
    return fail(
      'guarded write',
      `expected 401 on POST /api/quote-drafts/save, got ${guardedWrite.status}: ${snippet(guardedWrite)}`,
    );
  }
  pass('guarded write', '401 — a mutation is refused before it can write');
}

/**
 * Nothing private in the public projection.
 *
 * The catalogue is the one endpoint that returns rows from tables that also hold
 * a nursery's contact details, so this asserts on the field names rather than
 * trusting that the projection was used.
 */
const PRIVATE_FIELDS = ['owner_name', 'buyer_contact_phone', 'access_sub', 'tax_code', 'phone'] as const;

async function checkNoPrivateFields(): Promise<void> {
  const answer = await request('/api/public/catalog');
  if (answer.unreachable || answer.status !== 200) {
    return info('public PII', 'skipped: the catalogue did not answer 200');
  }
  const found = PRIVATE_FIELDS.filter((field) => answer.body.includes(`"${field}"`));
  if (found.length > 0) {
    return fail('public PII', `the public catalogue exposes ${found.join(', ')}`);
  }
  pass('public PII', 'no owner_name / phone / access_sub / tax_code in the public catalogue');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const started = Date.now();

await checkHealth();
await checkCatalog();
await checkSchema();
await checkDiscover();
await checkIdentityRefusals();
await checkNoPrivateFields();

const failures = results.filter((result) => result.status === 'FAIL');

for (const result of results) {
  process.stdout.write(`${result.status.padEnd(4)}  ${result.name.padEnd(18)} ${result.detail}\n`);
}

process.stdout.write(
  `\n${results.length - failures.length - results.filter((r) => r.status === 'INFO').length} passed, ` +
    `${failures.length} failed, ${results.filter((r) => r.status === 'INFO').length} skipped ` +
    `(${Date.now() - started} ms)\n`,
);

process.stdout.write(
  '\nWhat this does not prove, and must not be read as: that a person can sign in,\n' +
    'that a save survives a reload, or that any business flow works. Those need an\n' +
    'Access identity and a browser — see docs/PILOT-RUNBOOK.md §7, "Through the\n' +
    'browser, as the founder". A 401 is proof the gate is closed, not that the\n' +
    'pilot is usable.\n',
);

exit(failures.length === 0 ? 0 : 1);
