#!/usr/bin/env node
/**
 * The live check, as two questions that are not the same question.
 *
 *   1. **Readiness** — is the application serving? A catalogue that cannot reach
 *      the database is *not* serving, whatever status code it chose.
 *   2. **Fail-closed** — is it refusing what it must refuse? A missing token, a
 *      forged token, the development identity, an unauthorized mutation.
 *
 * They were one list before, and that was wrong in a way that matters: a `503`
 * carrying `code: "catalog_unavailable"` is *correct error handling*, and a check
 * that treats a correct `503` as a pass will report a deployment with no working
 * database as healthy. So a `503` now fails readiness, and is reported
 * separately as evidence that degraded handling behaved.
 *
 * What this still cannot do, and does not pretend to: prove that a **person** can
 * sign in and complete a business flow. That needs an Access identity, a browser
 * and a save that survives a reload. It stays a separate gate, run by a human,
 * and no list of `401`s here substitutes for it.
 *
 * It also never authenticates. Asking for a JWT would put one in a shell history,
 * a terminal buffer and a chat log to prove something a person can see for
 * themselves.
 */

import { exit } from 'node:process';

type Verdict = 'PASS' | 'FAIL' | 'INFO';
type Phase = 'readiness' | 'gates';

interface CheckResult {
  phase: Phase | 'note';
  name: string;
  status: Verdict;
  detail: string;
}

const results: CheckResult[] = [];

function record(phase: Phase | 'note', name: string, status: Verdict, detail: string): void {
  results.push({ phase, name, status, detail });
}

const pass = (phase: Phase, name: string, detail: string): void => record(phase, name, 'PASS', detail);
const fail = (phase: Phase, name: string, detail: string): void => record(phase, name, 'FAIL', detail);
const note = (name: string, detail: string): void => record('note', name, 'INFO', detail);

/** The environments in which the local identity adapter is permitted to exist. */
const DEVELOPMENT_ENVS = new Set(['local', 'test', 'development']);

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
const expectedEnv = flagValue('--expect-env');
const allowLocal = process.argv.includes('--local');

if (baseUrl === null || expectedEnv === null) {
  process.stderr.write(
    'Usage: pnpm smoke:live -- --base-url <url> --expect-env <local|test|demo|pilot>\n\n' +
      '--expect-env is required: the Worker reports the environment it thinks it is\n' +
      'in, and a deployment that reports the wrong one is a failure even when every\n' +
      'other check answers. Add --local only for http://localhost, and then expect a\n' +
      'development environment.\n',
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

// The expectation has to be of the right kind. Asking a local server to report
// `pilot`, or a deployment to report `local`, is a command error rather than a
// finding: it would either fail for the wrong reason or pass while proving
// nothing.
if (isLocalTarget && !DEVELOPMENT_ENVS.has(expectedEnv)) {
  process.stderr.write(
    `\nRefusing: ${origin} is a local target, so --expect-env ${expectedEnv} cannot be right.\n` +
      'A local run expects a development environment; a deployment check names the\n' +
      'deployment (demo or pilot) and a remote host.\n',
  );
  exit(2);
}
if (!isLocalTarget && DEVELOPMENT_ENVS.has(expectedEnv)) {
  process.stderr.write(
    `\nRefusing: ${origin} is a remote target, so --expect-env ${expectedEnv} cannot be right.\n` +
      'A Worker that reports a development environment on a public hostname is the\n' +
      'misconfiguration this check exists to catch, not a value to ask for.\n',
  );
  exit(2);
}

process.stdout.write(
  `Target:   ${origin}\n` +
    `Expected: APP_ENV=${expectedEnv}\n` +
    (isLocalTarget
      ? 'Scope:    LOCAL — a developer check, NOT a deployment check.\n'
      : 'Scope:    REMOTE — read-only, unauthenticated surface only.\n') +
    '\n',
);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface Answer {
  status: number;
  headers: Headers;
  body: string;
  json: unknown;
  unreachable: boolean;
  error: string | null;
}

async function request(path: string, init: RequestInit = {}): Promise<Answer> {
  try {
    const response = await fetch(`${origin}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        // A browser-shaped request: `Sec-Fetch-Site` is what the Worker checks on
        // a mutation, and without it every POST is refused for the wrong reason.
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
    return { status: response.status, headers: response.headers, body, json, unreachable: false, error: null };
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

function snippet(answer: Answer, limit = 90): string {
  const text = answer.body.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// Readiness — is the application actually serving?
// ---------------------------------------------------------------------------

let reportedEnv: string | null = null;

async function checkHealth(): Promise<void> {
  const answer = await request('/api/health');
  if (answer.unreachable) {
    return fail('readiness', 'health', `could not connect: ${answer.error}`);
  }
  if (answer.status !== 200) {
    return fail('readiness', 'health', `expected 200, got ${answer.status}: ${snippet(answer)}`);
  }
  const body = answer.json as { status?: unknown; env?: unknown } | null;
  if (body === null || body.status !== 'ok') {
    return fail('readiness', 'health', `expected {"status":"ok"}, got ${snippet(answer)}`);
  }
  const env = typeof body.env === 'string' ? body.env : '';
  reportedEnv = env;
  if (env !== expectedEnv) {
    return fail(
      'readiness',
      'environment',
      `the Worker reports APP_ENV="${env}", this run expected "${expectedEnv}" — ` +
        'a deployment on the wrong environment reads the wrong database',
    );
  }
  pass('readiness', 'health', `200, status=ok, APP_ENV="${env}" as expected`);
}

/**
 * The catalogue must actually read the database.
 *
 * `200 + lots` (empty is a real answer) is ready. `503` is **not**: it says the
 * read failed. It is recorded as a note rather than a pass, because the handling
 * being correct is worth knowing and is not the same as the application working.
 */
async function checkCatalog(): Promise<void> {
  const answer = await request('/api/public/catalog');
  if (answer.unreachable) {
    return fail('readiness', 'catalog', `could not connect: ${answer.error}`);
  }

  if (answer.status === 503) {
    const code = codeOf(answer);
    const cache = answer.headers.get('cache-control') ?? '';
    if (code === 'catalog_unavailable' && cache.includes('no-store')) {
      note(
        'degraded handling',
        'catalog answered 503 catalog_unavailable with no-store — correct handling of a failed read',
      );
    }
    return fail(
      'readiness',
      'catalog',
      `503 ${code ?? '(no code)'} — the database could not be read, so the application is not ready`,
    );
  }

  if (answer.status !== 200) {
    return fail('readiness', 'catalog', `expected 200, got ${answer.status}: ${snippet(answer)}`);
  }
  const body = answer.json as { lots?: unknown; error?: unknown } | null;
  if (body === null) return fail('readiness', 'catalog', `200 with a non-JSON body: ${snippet(answer)}`);
  if (body.error !== undefined) {
    return fail('readiness', 'catalog', `200 carrying an error: ${snippet(answer)}`);
  }
  if (!Array.isArray(body.lots)) {
    return fail('readiness', 'catalog', `200 without a lots array: ${snippet(answer)}`);
  }
  pass(
    'readiness',
    'catalog',
    body.lots.length === 0 ? '200, lots: [] — published nothing (a real answer)' : `200, ${body.lots.length} lot(s)`,
  );
}

/** The discovery page reads the same catalogue, so it must be ready too. */
async function checkDiscover(): Promise<void> {
  const answer = await request('/api/discover');
  if (answer.unreachable) return fail('readiness', 'discover', `could not connect: ${answer.error}`);
  if (answer.status === 200) {
    const type = answer.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) {
      return fail('readiness', 'discover', `200 with content-type "${type}"`);
    }
    return pass('readiness', 'discover', '200, HTML');
  }
  if (answer.status === 503) {
    note('degraded handling', 'discover answered 503 instead of inventing a page — correct handling');
    return fail('readiness', 'discover', '503 — the database could not be read, so the page is not ready');
  }
  fail('readiness', 'discover', `expected 200, got ${answer.status}`);
}

/** The machine-readable surface. Describes the service and reads no data. */
async function checkSchema(): Promise<void> {
  const answer = await request('/api/schema');
  if (answer.unreachable) return fail('readiness', 'schema', `could not connect: ${answer.error}`);
  if (answer.status !== 200) return fail('readiness', 'schema', `expected 200, got ${answer.status}`);
  if (answer.json === null) return fail('readiness', 'schema', 'expected JSON, got a non-JSON body');
  pass('readiness', 'schema', '200, JSON');
}

// ---------------------------------------------------------------------------
// Fail-closed — does it refuse what it must refuse?
// ---------------------------------------------------------------------------

/**
 * No credential, a forged bearer, a forged Access assertion, and the old
 * development header. All must be `401`.
 *
 * `Cf-Access-Jwt-Assertion` is the header Access itself sets, and the one the
 * Worker's verifier reads. A forged value there is the closest thing to "a token
 * that looks like the real one" that can be tested without a real token.
 */
async function checkRefusals(): Promise<void> {
  if (reportedEnv !== null && DEVELOPMENT_ENVS.has(reportedEnv)) {
    note(
      'identity checks',
      `skipped: the Worker reports APP_ENV="${reportedEnv}", where the labelled demo identity signs in by design`,
    );
    return;
  }

  const cases: { name: string; path: string; init?: RequestInit; detail: string }[] = [
    { name: 'session/anonymous', path: '/api/session', detail: 'no credential' },
    {
      name: 'session/forged-access-jwt',
      path: '/api/session',
      init: { headers: { 'cf-access-jwt-assertion': 'forged.header.value' } },
      detail: 'a forged Cf-Access-Jwt-Assertion',
    },
    {
      name: 'session/forged-bearer',
      path: '/api/session',
      init: { headers: { authorization: 'Bearer not-a-real-access-token' } },
      detail: 'a forged bearer token',
    },
    {
      name: 'session/dev-identity',
      path: '/api/session',
      init: { headers: { 'x-dev-identity': 'demo-admin' } },
      detail: 'the development identity header',
    },
    {
      name: 'guarded read',
      path: '/api/products',
      init: { headers: { 'cf-access-jwt-assertion': 'forged.header.value' } },
      detail: 'a guarded read with no verified identity',
    },
  ];

  for (const testCase of cases) {
    const answer = await request(testCase.path, testCase.init ?? {});
    if (answer.unreachable) {
      fail('gates', testCase.name, `could not connect: ${answer.error}`);
      continue;
    }
    if (answer.status === 200) {
      fail('gates', testCase.name, `200 for ${testCase.detail} — the gate is open`);
    } else if (answer.status !== 401) {
      fail('gates', testCase.name, `expected 401, got ${answer.status}: ${snippet(answer)}`);
    } else {
      pass('gates', testCase.name, `401 — ${testCase.detail} refused`);
    }
  }

  const write = await request('/api/quote-drafts/save', {
    method: 'POST',
    headers: { 'cf-access-jwt-assertion': 'forged.header.value', 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (write.unreachable) {
    fail('gates', 'guarded write', `could not connect: ${write.error}`);
  } else if (write.status !== 401) {
    fail('gates', 'guarded write', `expected 401, got ${write.status}: ${snippet(write)}`);
  } else {
    pass('gates', 'guarded write', '401 — a mutation is refused before it can write');
  }
}

/**
 * Nothing private in the public projection.
 *
 * It needs a readable catalogue, so it is skipped — with the reason — when the
 * catalogue answered 503; a skipped leak check is not a passed one.
 */
const PRIVATE_FIELDS = ['owner_name', 'buyer_contact_phone', 'access_sub', 'tax_code', 'phone'] as const;

async function checkNoPrivateFields(): Promise<void> {
  const answer = await request('/api/public/catalog');
  if (answer.unreachable || answer.status !== 200) {
    return note('public PII', 'skipped: the catalogue did not answer 200, so there was nothing to inspect');
  }
  const found = PRIVATE_FIELDS.filter((field) => answer.body.includes(`"${field}"`));
  if (found.length > 0) {
    return fail('gates', 'public PII', `the public catalogue exposes ${found.join(', ')}`);
  }
  pass('gates', 'public PII', 'no owner_name / phone / access_sub / tax_code in the public catalogue');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const started = Date.now();

await checkHealth();
await checkCatalog();
await checkDiscover();
await checkSchema();
await checkRefusals();
await checkNoPrivateFields();

for (const result of results) {
  const label = result.status === 'INFO' ? 'INFO' : result.status;
  process.stdout.write(`${label.padEnd(4)}  ${result.name.padEnd(24)} ${result.detail}\n`);
}

function tally(phase: Phase): { passed: number; failed: number } {
  const inPhase = results.filter((result) => result.phase === phase);
  return {
    passed: inPhase.filter((result) => result.status === 'PASS').length,
    failed: inPhase.filter((result) => result.status === 'FAIL').length,
  };
}

const readiness = tally('readiness');
const gates = tally('gates');
const failures = results.filter((result) => result.status === 'FAIL').length;
const notes = results.filter((result) => result.status === 'INFO').length;

process.stdout.write(
  `\nReadiness: ${readiness.passed} passed, ${readiness.failed} failed` +
    `${readiness.failed > 0 ? ' — NOT READY' : ''}\n` +
    `Gates:     ${gates.passed} passed, ${gates.failed} failed\n` +
    `Notes:     ${notes} (not passes, and not failures)\n` +
    `(${Date.now() - started} ms)\n`,
);

process.stdout.write(
  '\nWhat this does not prove: that a person can sign in, that a save survives a\n' +
    'reload, or that any business flow works. Those need an Access identity and a\n' +
    'browser — see docs/PILOT-RUNBOOK.md §7, "Through the browser, as the founder".\n' +
    'A 401 proves the gate is closed; it is not evidence that the pilot is usable.\n',
);

exit(failures === 0 ? 0 : 1);
