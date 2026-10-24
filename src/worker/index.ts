/**
 * The Worker entry.
 *
 * Routes are closed until declared open. Every `/api/*` request must resolve an
 * identity through the verified Access token and pass `authorize`; a route is
 * reachable only by being listed as public, so a route added later cannot be
 * left unguarded by omission.
 *
 * Identity comes from the `Cf-Access-Jwt-Assertion` header, verified here rather
 * than read from `ctx.access`. Workers with Static Assets run behind an internal
 * router Worker, and that router does not pass `ctx.access` to this Worker, so
 * waiting on it would refuse the founder on a deployment while passing locally.
 */

import { authorize, denialMessage } from '../security/authorize.ts';
import type { MembershipStore } from '../security/authorize.ts';
import {
  assertRegistryIsSound,
  contextFromRequest,
  forbidden,
  unauthorized,
} from './api.ts';
import type { Route } from './api.ts';

/**
 * The registry. A new route is added here with its action, and the registry test
 * refuses a guarded entry that names no action, so an unguarded route fails a
 * test rather than reaching a deployment.
 */
const ROUTES: Route[] = [
  // Health is public so an operator can confirm the Worker is alive. It reports
  // nothing about how authentication works.
  { kind: 'public', path: '/api/health' },
];

assertRegistryIsSound({ routes: ROUTES });

/** The membership store used by this deployment. Replaced in tests. */
let membershipStore: MembershipStore | null = null;

export function setMembershipStore(store: MembershipStore): void {
  membershipStore = store;
}

/** Handles an API request, refusing anything the registry does not open. */
async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = ROUTES.find((entry) => entry.path === url.pathname);

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
  if (membershipStore === null) {
    return forbidden('Hệ thống chưa sẵn sàng xử lý yêu cầu này.');
  }

  const identity = verifyAccessIdentity(request, env);
  const context = contextFromRequest(identity, url.searchParams);

  const result = await authorize(membershipStore, {
    accessSubject: context.identity?.accessSubject ?? null,
    action: route.action,
    workspaceId: context.workspaceId,
  });

  if (result.kind === 'denied') {
    return result.reason === 'no_identity' ? unauthorized() : forbidden(denialMessage(result.reason));
  }

  // A handler would go here, with result.authorization available. Phase 2 and 3
  // add them; the boundary they must pass through is this one.
  return new Response(JSON.stringify({ error: 'Chưa triển khai.' }), {
    status: 501,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Verifies the Access token and returns the identity, or null.
 *
 * The verification itself is supplied by the auth module, which is the only place
 * that knows the JWKS location and the claims to check. This function stays
 * thin so a failure path is visible at one glance: no token, no identity, and
 * `authorize` decides what that means.
 */
function verifyAccessIdentity(
  request: Request,
  env: Env,
): { accessSubject: string; email: string | null } | null {
  const resolved = resolveVerifier(env);
  if (resolved.verifier === null) return null;
  return resolved.verifier(request.headers.get('Cf-Access-Jwt-Assertion'));
}

/** A verifier: one Access token header in, an identity out or nothing. */
export type Verifier = (
  headerValue: string | null,
) => { accessSubject: string; email: string | null } | null;

/**
 * The verifier, injected by the environment that knows how to check a token.
 *
 * There is deliberately no fallback that invents an identity. A deployment
 * without the Access configuration has no verifier, so every guarded route
 * refuses — which is §6's fail-closed requirement, applied rather than described.
 */
let verifier: Verifier | null = null;

export function setVerifier(candidate: Verifier | null): void {
  verifier = candidate;
}

/** Reads the verifier, reporting whether the Access configuration is present. */
function resolveVerifier(
  env: Env,
): { verifier: Verifier; configured: true } | { verifier: null; configured: boolean } {
  if (verifier !== null) return { verifier, configured: true };
  const configured =
    typeof env.ACCESS_TEAM_DOMAIN === 'string' &&
    env.ACCESS_TEAM_DOMAIN.trim() !== '' &&
    typeof env.ACCESS_AUD === 'string' &&
    env.ACCESS_AUD.trim() !== '';
  if (!configured) return { verifier: null, configured: false };
  // Configured but no verifier injected means the deployment is incomplete
  // rather than misconfigured. A pilot never runs in this state, because
  // deploy:preview refuses to deploy without the values.
  return { verifier: null, configured: true };
}

interface Env {
  APP_ENV?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  [key: string]: unknown;
}

function handleHealth(env: Env): Response {
  return new Response(
    JSON.stringify({ status: 'ok', env: env.APP_ENV ?? 'local' }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }
    return new Response('Not found', { status: 404 });
  },
};
