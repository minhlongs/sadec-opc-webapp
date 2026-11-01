/**
 * A stand-in for the Cloudflare API, used to run the real `cf-preflight.ts` with
 * no network.
 *
 * The point of running the CLI rather than calling the decision directly is the
 * part a unit test cannot see: the shape the API answers with, read by the code
 * that gathers it, and the exit code an operator's workflow branches on. A test
 * that builds the facts object by hand skips exactly the layer where the last
 * prefix bug lived.
 *
 * Loaded with `node --import`, which runs before the CLI's first `fetch`.
 * `STUB_SCENARIO` chooses the bucket's rules; anything unset answers a clean
 * bucket on the export prefix.
 */

const ACCOUNT = 'f691e83094f776311a1bfe3f8b126f1c';
const DATABASE = '5d2bd39f-93c0-400b-8207-586e17023cf2';
const BUCKET = 'sadec-pilot-backups';

const days = (count) => count * 86_400;

const lifecycleRules = {
  ok: [{ id: 'expire-pilot', enabled: true, prefix: 'pilot/', deleteObjectsAfterDays: 30 }],
  mixed: [
    { id: 'expire-pilot', enabled: true, prefix: 'pilot/', deleteObjectsAfterDays: 7 },
    { id: 'expire-other', enabled: true, prefix: 'other/', deleteObjectsAfterDays: 30 },
  ],
  'other-only': [{ id: 'expire-other', enabled: true, prefix: 'other/', deleteObjectsAfterDays: 30 }],
  disabled: [
    { id: 'expire-pilot', enabled: false, prefix: 'pilot/', deleteObjectsAfterDays: 30 },
    { id: 'expire-other', enabled: true, prefix: 'other/', deleteObjectsAfterDays: 30 },
  ],
  wide: [{ id: 'expire-all', enabled: true, prefix: '', deleteObjectsAfterDays: 30 }],
  nested: [
    {
      id: 'expire-nested',
      enabled: true,
      conditions: { prefix: 'pilot/' },
      deleteObjectsTransition: { condition: { type: 'Age', maxAgeSeconds: days(30) } },
    },
  ],
  lookalike: [
    { id: 'expire-lookalike', enabled: true, prefix: 'pilot-archive/', deleteObjectsAfterDays: 30 },
  ],
  unreadable: [
    {
      id: 'expire-odd',
      enabled: true,
      prefix: 'pilot/',
      deleteObjectsTransition: { condition: { type: 'Date' } },
    },
  ],
  none: [],
};

const lockRules = {
  ok: [{ id: 'lock-pilot', enabled: true, prefix: 'pilot/', condition: { type: 'Age', maxAgeSeconds: days(30) } }],
  mixed: [
    { id: 'lock-pilot', enabled: true, prefix: 'pilot/', condition: { type: 'Age', maxAgeSeconds: days(7) } },
    { id: 'lock-other', enabled: true, prefix: 'other/', condition: { type: 'Age', maxAgeSeconds: days(30) } },
  ],
  'other-only': [
    { id: 'lock-other', enabled: true, prefix: 'other/', condition: { type: 'Age', maxAgeSeconds: days(30) } },
  ],
  disabled: [
    { id: 'lock-pilot', enabled: false, prefix: 'pilot/', condition: { type: 'Age', maxAgeSeconds: days(30) } },
    { id: 'lock-other', enabled: true, prefix: 'other/', condition: { type: 'Age', maxAgeSeconds: days(30) } },
  ],
  wide: [{ id: 'lock-all', enabled: true, prefix: '', condition: { type: 'Age', maxAgeSeconds: days(30) } }],
  nested: [
    { id: 'lock-nested', enabled: true, conditions: { prefix: 'pilot/' }, condition: { type: 'Age', maxAgeSeconds: days(30) } },
  ],
  lookalike: [
    { id: 'lock-lookalike', enabled: true, prefix: 'pilot-archive/', condition: { type: 'Age', maxAgeSeconds: days(30) } },
  ],
  unreadable: [{ id: 'lock-odd', enabled: true, prefix: 'pilot/' }],
  none: [],
};

const scenario = process.env.STUB_SCENARIO ?? 'ok';
const scenarioRules = (table, name) => table[scenario] ?? table[name] ?? [];

function answer(url) {
  const path = new URL(url).pathname;
  if (path === `/client/v4/accounts/${ACCOUNT}`) return { id: ACCOUNT, name: 'stub-account' };
  if (path === `/client/v4/accounts/${ACCOUNT}/d1/database`) {
    return [{ id: DATABASE, name: 'sadec-pilot' }];
  }
  if (path.endsWith('/workers/scripts/sadec-flow-pilot')) return { id: 'sadec-flow-pilot' };
  if (path.endsWith(`/r2/buckets/${BUCKET}`)) return { name: BUCKET };
  if (path.endsWith('/domains/managed')) return { enabled: false };
  if (path.endsWith('/domains/custom')) return { domains: [] };
  if (path.endsWith('/lifecycle')) return { rules: scenarioRules(lifecycleRules, 'ok') };
  if (path.endsWith('/lock')) return { rules: scenarioRules(lockRules, 'ok') };
  if (path === `/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}`) {
    return { id: DATABASE, name: 'sadec-pilot' };
  }
  return undefined;
}

globalThis.fetch = async (url) => {
  const result = answer(String(url));
  const body =
    result === undefined
      ? { success: false, errors: [{ code: 1, message: 'stub: no route for this path' }] }
      : { success: true, result };
  return new Response(JSON.stringify(body), {
    status: result === undefined ? 404 : 200,
    headers: { 'content-type': 'application/json' },
  });
};
