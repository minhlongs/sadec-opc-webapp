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
} from '../ops/routes.ts';
import type { D1Like } from '../ops/catalog.ts';
import { resolveDevIdentity } from '../security/dev-identity.ts';
import {
  assertRegistryIsSound,
  contextFromRequest,
  forbidden,
  unauthorized,
} from './api.ts';
import type { Route } from './api.ts';

type Verifier = (
  headerValue: string | null,
) => { accessSubject: string; email: string | null } | null;

/**
 * The registry. A new route is added here with its action, and the registry test
 * refuses a guarded entry that names no action, so an unguarded route fails a
 * test rather than reaching a deployment.
 */
const ROUTES: Route[] = [
  // Health is public so an operator can confirm the Worker is alive. It reports
  // nothing about how authentication works.
  { kind: 'public', path: '/api/health' },

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
  const name = BINDING_BY_ENVIRONMENT[(env.APP_ENV ?? 'local').trim().toLowerCase()];
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
function resolveIdentity(
  request: Request,
  env: Env,
): { accessSubject: string; email: string | null; demo: boolean } | null {
  const demo = resolveDevIdentity(env.APP_ENV, env.DEV_IDENTITY_SUBJECT);
  if (demo !== null) {
    return {
      accessSubject: demo.accessSubject,
      email: demo.email,
      demo: true,
    };
  }

  if (verifier === null) return null;
  const verified = verifier(request.headers.get('Cf-Access-Jwt-Assertion'));
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

  const identity = resolveIdentity(request, env);
  const context = contextFromRequest(identity, url.searchParams);

  // A write also proves where it came from. §6 asks for origin checking on
  // mutations, and the cheap version is exact-match against the request's own
  // origin — which catches a cross-site form post without a token dance.
  if (request.method !== 'GET' && request.method !== 'HEAD' && !originMatches(request, url)) {
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
 * Whether a mutation carries an origin this deployment accepts.
 *
 * An exact match against the request's own origin. A request with no Origin
 * header at all is refused for a mutation: a browser attaching credentials to a
 * cross-site form does send one, so its absence is the non-browser case, and a
 * non-browser client can set it correctly with no cost.
 */
function originMatches(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin');
  if (origin === null) return false;
  return origin === url.origin;
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

      if (!roles.has(row.role as Role)) {
        throw new Error(
          `The database holds a role this build does not know: ${row.role}. ` +
            'A migration added a role without updating the permission table.',
        );
      }

      return {
        identityId: row.identity_id,
        role: row.role as Role,
        revokedAt: row.revoked_at,
      };
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
      return handleApi(request, env, ctx);
    }
    return new Response('Not found', { status: 404 });
  },
};
