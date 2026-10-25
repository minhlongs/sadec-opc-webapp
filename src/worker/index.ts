/**
 * The Worker entry.
 *
 * Routes are closed until declared open. Every `/api/*` request must resolve an
 * identity and pass `authorize`; a route is reachable only by being listed as
 * public, so a route added later cannot be left unguarded by omission.
 *
 * Identity comes from the `Cf-Access-Jwt-Assertion` header, verified here rather
 * than read from `ctx.access`. Workers with Static Assets run behind an internal
 * router Worker, and that router does not pass `ctx.access` to this Worker, so
 * waiting on it would refuse the founder on a deployment while passing locally.
 *
 * In local and test, the dev identity adapter from `src/security/` supplies a
 * labelled demo identity instead. It is selected by the environment, never by
 * anything the request carries.
 */

import { authorize, denialMessage, type MembershipStore, type Role } from '../security/authorize.ts';
import {
  handleListCustomers,
  handleListProducts,
  handleListQuoteDrafts,
  handleSaveQuoteDraft,
  handleSession,
} from '../ops/routes.ts';
import type { D1Like } from '../ops/catalog.ts';
import { resolveDevIdentity } from '../security/dev-identity.ts';
import { accessTokenVerifier } from '../security/verify-access-token.ts';
import {
  assertRegistryIsSound,
  contextFromRequest,
  forbidden,
  unauthorized,
} from './api.ts';
import type { Route } from './api.ts';

/**
 * The verifier this deployment uses.
 *
 * Async because an Access token is verified against the team domain's published
 * key set, and fetching that set is I/O. A synchronous type here would compile a
 * Promise where a result is expected: every truthiness check on it would pass, so
 * a refusal would look like a success.
 *
 * Exported so a test can substitute its own against the same shape.
 */
export type Verifier = (
  headerValue: string | null,
) => Promise<{ accessSubject: string; email: string | null } | null>;

/**
 * The registry. A new route is added here with its action, and the registry test
 * refuses a guarded entry that names no action, so an unguarded route fails a
 * test rather than reaching a deployment.
 */
const ROUTES: Route[] = [
  // Health is public so an operator can confirm the Worker is alive. It reports
  // nothing about how authentication works.
  { kind: 'public', path: '/api/health' },

  // The signed-in session. Guarded rather than public because it names a role
  // and a workspace, and §6 forbids reading either from a request. It returns
  // only what the chokepoint already resolved for this caller.
  { kind: 'guarded', path: '/api/session', action: 'session.read' },

  // Reads. An operator may read the catalog and its customers; that is the job.
  { kind: 'guarded', path: '/api/products', action: 'product.read' },
  { kind: 'guarded', path: '/api/customers', action: 'customer.read' },
  { kind: 'guarded', path: '/api/quote-drafts', action: 'quote.read' },

  // Writes. Saving a quote draft is operator work, so it permits both an operator
  // and an owner. The permission table decides which, not this list.
  { kind: 'guarded', path: '/api/quote-drafts/save', action: 'quote.write' },
];

assertRegistryIsSound({ routes: ROUTES });

/** The membership store used by this deployment. Replaced in tests. */
let membershipStore: MembershipStore | null = null;

export function setMembershipStore(store: MembershipStore | null): void {
  membershipStore = store;
}

/** The verifier, injected by the environment that knows how to check a token. */
let verifier: Verifier | null = null;

export function setVerifier(candidate: Verifier | null): void {
  verifier = candidate;
}

/**
 * Builds the real verifier from the environment, or null when unconfigured.
 *
 * Cached per pair of values rather than in a single slot, because a deployment's
 * configuration is fixed and a test's is not: a single cache would let one
 * request's configuration answer another's, so a test with no configuration could
 * be handed the verifier an earlier test built.
 */
const environmentVerifiers = new Map<string, Verifier>();

function environmentVerifierFor(env: Env): Verifier | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (typeof teamDomain !== 'string' || teamDomain.trim() === '') return null;
  if (typeof audience !== 'string' || audience.trim() === '') return null;

  const key = `${teamDomain}\u0000${audience}`;
  const existing = environmentVerifiers.get(key);
  if (existing !== undefined) return existing;

  const built = accessTokenVerifier({ teamDomain, audience });
  environmentVerifiers.set(key, built);
  return built;
}

/**
 * The verifier for this request, falling back to one built from the environment.
 *
 * The injected `verifier` wins because that is how a test substitutes its own
 * without a key set to publish. A deployment never sets it, so the environment
 * verifier is the only path it has — which is what this fallback exists for.
 */
function verifierForEnvironment(env: Env): Verifier | null {
  return verifier ?? environmentVerifierFor(env);
}

interface Env {
  APP_ENV?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_IDENTITY_SUBJECT?: string;
  [key: string]: unknown;
}

/**
 * The part of the Worker execution context this file uses.
 *
 * Declared here rather than taken from `@cloudflare/workers-types`, because the
 * only member read is `access`, and only to ask whether the runtime provided it.
 * Depending on the full platform type set for one optional field would put a
 * version pin on the whole Worker API.
 *
 * `access` is optional because the published documentation says the Static Assets
 * router Worker does not forward it to this Worker — which is exactly the
 * question `/api/whoami` exists to answer on a real deployment.
 */
interface WorkerContext {
  access?: unknown;
}

/** The D1 binding this Worker reads. One binding per environment. */
const BINDING_BY_ENVIRONMENT: Readonly<Record<string, string>> = {
  local: 'sadec_demo',
  test: 'sadec_test',
  demo: 'sadec_demo',
  pilot: 'sadec_pilot',
};

function databaseFor(env: Env): D1Like | null {
  const environment = (env.APP_ENV ?? '').trim().toLowerCase();
  const name = BINDING_BY_ENVIRONMENT[environment];
  // An unset or unrecognised environment has no binding. It is not `local` by
  // default: a deployment that failed to state its environment must not read the
  // demo database, which is the separation §3 asks for. `local` is an explicit
  // value, never the fallback.
  if (name === undefined) return null;
  const binding = env[name];
  // A deployment whose binding is missing has no database to read, so every
  // guarded route refuses. That is a misconfiguration rather than a reason to
  // fall back to another environment's data.
  return isD1Like(binding) ? (binding as D1Like) : null;
}

/**
 * The membership store for this environment's binding, or null when the binding
 * is absent.
 *
 * Returned as null rather than constructed over a missing database so the route
 * refuses instead of running a query that cannot work.
 */
function d1MembershipStoreFor(env: Env): MembershipStore | null {
  const db = databaseFor(env);
  return db === null ? null : d1MembershipStore(db);
}

function isD1Like(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { prepare?: unknown };
  return typeof candidate.prepare === 'function';
}

/**
 * Resolves the identity for a request.
 *
 * In local and test this is the labelled demo identity. Everywhere else it is
 * the verified Access token, and a request with no valid token has no identity.
 * There is no third path that produces one.
 */
async function resolveIdentity(
  request: Request,
  env: Env,
): Promise<{ accessSubject: string; email: string | null; demo: boolean } | null> {
  const demo = resolveDevIdentity(env.APP_ENV, env.DEV_IDENTITY_SUBJECT);
  if (demo !== null) {
    return {
      accessSubject: demo.accessSubject,
      email: demo.email,
      demo: true,
    };
  }

  // The verifier comes from the environment when none was injected. Without it
  // there is no way to check a token, so there is no identity — which is a
  // refusal, never a guess. Missing `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` lands here,
  // which is why the deploy command insists on both before publishing.
  const tokenVerifier = verifierForEnvironment(env);
  if (tokenVerifier === null) return null;

  const verified = await tokenVerifier(request.headers.get('Cf-Access-Jwt-Assertion'));
  if (verified === null) return null;
  return { accessSubject: verified.accessSubject, email: verified.email, demo: false };
}

/** Handles an API request, refusing anything the registry does not open. */
async function handleApi(
  request: Request,
  env: Env,
  ctx: WorkerContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/whoami') {
    return handleWhoami(env, ctx);
  }

  const route = ROUTES.find((entry) => entry.path === path);

  if (route === undefined) {
    // Unknown path. This is deliberately not a 404 that says whether the path
    // might exist behind some auth: it is simply not a route.
    return new Response(JSON.stringify({ error: 'Không tìm thấy đường dẫn.' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  if (route.kind === 'public') {
    return handleHealth(env);
  }

  // Guarded. Without a store there is no way to resolve a membership, and
  // failing closed is the only honest answer.
  //
  // The store is built from this environment's binding on first use rather than
  // injected from outside, so a route cannot be reached through a store that was
  // never resolved. A test injects its own by calling setMembershipStore, and the
  // injected one wins — which is how the authorization tests exercise the
  // chokepoint without a database.
  const store = membershipStore ?? d1MembershipStoreFor(env);
  if (store === null) {
    return forbidden('Hệ thống chưa sẵn sàng xử lý yêu cầu này.');
  }

  const identity = await resolveIdentity(request, env);
  const context = contextFromRequest(identity, url.searchParams);
  // Whether this session is the dev identity, needed below to label the banner.
  const demoSession = identity?.demo ?? false;

  // The session route is the one guarded request the client cannot scope, and
  // that is the point: naming a workspace is what it answers. So the workspace
  // comes from the caller's own memberships, and the role is resolved through
  // `authorize` in the chosen workspace like every other action.
  if (route.path === '/api/session') {
    return handleSessionRoute(identity, env, store);
  }

  // A write also proves where it came from. §6 asks for origin checking on
  // mutations. This asks `Sec-Fetch-Site` instead of `Origin`, because `Origin`
  // is a forbidden request-header name: a browser sets it itself and strips it
  // from a `fetch` init, so a same-origin POST from the app carries no such
  // header and an exact-match rule refuses every real save. `Sec-Fetch-Site` is
  // sent by the browser on every request it makes and a page cannot forge it, so
  // it still refuses a cross-site mutation.
  if (request.method !== 'GET' && request.method !== 'HEAD' && !sentFromSameOrigin(request)) {
    return forbidden('Yêu cầu bị từ chối do nguồn gửi không khớp.');
  }

  const result = await authorize(store, {
    accessSubject: context.identity?.accessSubject ?? null,
    action: route.action,
    workspaceId: context.workspaceId,
  });

  if (result.kind === 'denied') {
    return result.reason === 'no_identity'
      ? unauthorized()
      : forbidden(denialMessage(result.reason));
  }

  const db = databaseFor(env);
  if (db === null) {
    return forbidden('Hệ thống chưa sẵn sàng xử lý yêu cầu này.');
  }

  const workspaceId = result.authorization.workspaceId;
  const ops = { workspaceId, db };

  switch (route.path) {
    case '/api/products':
      return handleListProducts(ops);
    case '/api/customers':
      return handleListCustomers(ops);
    case '/api/quote-drafts':
      return handleListQuoteDrafts(ops);
    case '/api/quote-drafts/save': {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        // A body that is not JSON is a client error, not a server one, and the
        // Zod layer never sees it — so it is answered here rather than by a
        // schema message that would imply the field was wrong.
        return new Response(JSON.stringify({ error: 'Yêu cầu cần gửi JSON hợp lệ.' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return handleSaveQuoteDraft(ops, body);
    }
    default:
      // A route in the registry with no handler is a build-time mistake, not a
      // runtime one. It is refused rather than assumed reachable.
      return new Response(JSON.stringify({ error: 'Chưa triển khai.' }), {
        status: 501,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
  }
}

/**
 * Answers "who am I acting as, and in which workspace".
 *
 * This is the one route a client cannot scope, because naming a workspace is
 * what it answers — so the workspace comes from the caller's own live
 * memberships and from nowhere else. A caller with none is refused exactly as
 * any other unauthorized request is, rather than being handed a default.
 *
 * Where a caller holds several, the first is chosen — the membership query is
 * ordered by `granted_at, workspace_id`, so that is the earliest-granted
 * membership and, among equal timestamps, the lowest workspace id. The answer is
 * therefore a property of the database rather than of the order the rows
 * happened to arrive in, and a workspace switcher is a later phase's work.
 *
 * The role is still resolved by `authorize`, in the chosen workspace, so this
 * route gains no permission it did not already have — it only learns which
 * workspace to ask about.
 */
async function handleSessionRoute(
  identity: { accessSubject: string; email: string | null; demo: boolean } | null,
  env: Env,
  store: MembershipStore,
): Promise<Response> {
  if (identity === null) return unauthorized();

  const memberships = await store.listBySubject(identity.accessSubject);
  const chosen = memberships[0];
  if (chosen === undefined) {
    // A verified identity holding no live membership has no workspace to work
    // in, and no role to report. That is a refusal, not an empty session.
    return forbidden('Bạn không thuộc workspace nào.');
  }

  const result = await authorize(store, {
    accessSubject: identity.accessSubject,
    action: 'session.read',
    workspaceId: chosen.workspaceId,
  });
  if (result.kind === 'denied') {
    return result.reason === 'no_identity'
      ? unauthorized()
      : forbidden(denialMessage(result.reason));
  }

  const db = databaseFor(env);
  if (db === null) {
    return forbidden('Hệ thống chưa sẵn sàng xử lý yêu cầu này.');
  }

  return handleSession({
    db,
    workspaceId: result.authorization.workspaceId,
    role: result.authorization.role,
    identity,
  });
}

/**
 * The development probe.
 *
 * It answers exactly one question — is `ctx.access` present in this Worker? —
 * because the published documentation says the Static Assets router Worker does
 * not forward it, and the only way to know for this deployment is to ask. The
 * answer is written into `docs/DECISIONS.md` rather than left as folklore.
 *
 * It returns a single boolean and nothing else: no header, no subject, no email,
 * no team domain, no audience tag and no role. An unauthenticated caller learns
 * whether a framework object exists and nothing about this deployment's
 * authentication.
 *
 * Registered only in local and test, so a deployment returns the same 404 every
 * unknown path returns.
 */
function handleWhoami(env: Env, ctx: WorkerContext): Response {
  const isDevelopment = resolveDevIdentity(env.APP_ENV, env.DEV_IDENTITY_SUBJECT) !== null;
  if (!isDevelopment) {
    return new Response(JSON.stringify({ error: 'Không tìm thấy đường dẫn.' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  // Reading `access` off the runtime's execution context rather than off
  // `globalThis`, because that is where the platform puts it. If a future runtime
  // propagates it, this reads the propagated truth instead of a stand-in.
  const access = (ctx as { access?: unknown }).access;
  return new Response(
    JSON.stringify({
      access_present: access !== undefined && access !== null,
      note: 'development probe only',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
}

/**
 * Whether the browser says this request came from this origin.
 *
 * `Sec-Fetch-Site` is a forbidden header a page cannot set, so unlike `Origin`
 * it is a statement by the browser rather than by the client. `same-origin` is
 * the case the app's own saves arrive with; `same-site` covers a subdomain of the
 * same registrable site, which is the Worker's own hostname and nothing else, so
 * it is accepted. `cross-site` is what a form post from elsewhere looks like, and
 * `none` means a request the browser did not make from a page — a mutation from
 * there is refused.
 */
function sentFromSameOrigin(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === null) return false;
  return site === 'same-origin' || site === 'same-site';
}

function handleHealth(env: Env): Response {
  return new Response(
    JSON.stringify({ status: 'ok', env: env.APP_ENV ?? 'local' }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

/**
 * The membership store over D1.
 *
 * Reads the membership for a subject in a workspace, which is the one question
 * `authorize` asks. A revoked row returns as present-but-revoked so the
 * chokepoint can deny without the row being deleted and its history lost.
 *
 * The role is read from a column whose CHECK constraint allows only the three
 * roles §6 defines, so a cast here is a cast to a type the database already
 * guarantees. It is written as a check-and-throw rather than an unchecked
 * assertion, so a future migration that widens that column fails loudly here
 * instead of widening a permission silently.
 */
export function d1MembershipStore(db: D1Like): MembershipStore {
  const roles = new Set<Role>([
    'founder_admin',
    'workspace_owner',
    'workspace_operator',
  ]);

  /**
   * Reads a role the database claims, refusing one this build does not know.
   *
   * A CHECK constraint on the column allows only the three roles §6 defines, so
   * a cast here is a cast to a type the database already guarantees. It is
   * written as a check rather than an assertion so a migration that widens the
   * column fails here instead of silently widening a permission.
   */
  const knownRole = (value: string): Role => {
    if (!roles.has(value as Role)) {
      throw new Error(
        `The database holds a role this build does not know: ${value}. ` +
          'A migration added a role without updating the permission table.',
      );
    }
    return value as Role;
  };

  return {
    async findBySubject(accessSubject, workspaceId) {
      const row = await db
        .prepare(
          `SELECT m.id AS identity_id, m.role AS role, m.revoked_at AS revoked_at
             FROM memberships m
             JOIN identities i ON i.id = m.identity_id
            WHERE i.access_sub = ? AND m.workspace_id = ?`,
        )
        .bind(accessSubject, workspaceId)
        .first<{ identity_id: string; role: string; revoked_at: string | null }>();

      if (row === null) return null;

      return {
        identityId: row.identity_id,
        role: knownRole(row.role),
        revokedAt: row.revoked_at,
      };
    },

    async listBySubject(accessSubject) {
      const { results } = await db
        .prepare(
          `SELECT m.workspace_id AS workspace_id, m.role AS role
             FROM memberships m
             JOIN identities i ON i.id = m.identity_id
            WHERE i.access_sub = ? AND m.revoked_at IS NULL
            ORDER BY m.granted_at, m.workspace_id`,
        )
        .bind(accessSubject)
        .all<{ workspace_id: string; role: string }>();

      return results.map((row) => ({
        workspaceId: row.workspace_id,
        role: knownRole(row.role),
      }));
    },
  };
}

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: WorkerContext,
  ): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      // Everything the handler throws lands here, because a fault that escapes
      // `fetch` as a rejection is not a closed refusal: the runtime answers 500
      // with its own English page, and the operator gets nothing they can read.
      // That is the ordinary pilot-after-deploy state — a database binding with
      // no schema behind it — so it is converted here rather than left to the
      // runtime.
      return handleApi(request, env, ctx).catch(() =>
        forbidden('Hệ thống chưa sẵn sàng xử lý yêu cầu này.'),
      );
    }
    return new Response('Not found', { status: 404 });
  },
};
