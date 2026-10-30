/**
 * The API shell: routes are closed until declared open.
 *
 * §6 requires every API operation to authenticate and check permission. The
 * practical failure this guards against is not a weak check but a missing one —
 * a route written next sprint that nobody remembered to protect, which looks
 * exactly like the routes around it.
 *
 * So the default here is the opposite of the usual: a route is registered, and
 * it is unreachable, until the handler explicitly says it is public. There is no
 * way to add a route and forget.
 */

/** The identity extracted from a verified Access token. */
export interface VerifiedIdentity {
  accessSubject: string;
  email: string | null;
}

/** What a handler needs to serve a request. */
export interface RequestContext {
  identity: VerifiedIdentity | null;
  /** The workspace the request names. Never trusted on its own. */
  workspaceId: string | null;
}

export type PublicRoute = {
  kind: 'public';
  path: string;
};

export type GuardedRoute = {
  kind: 'guarded';
  path: string;
  /** The action name that `authorize` checks, which must be declared there. */
  action: string;
};

export type Route = PublicRoute | GuardedRoute;

export interface RouteRegistry {
  routes: readonly Route[];
}

/**
 * Throws when the registry contains a route that is neither closed nor declared
 * public, so a mis-declared route fails a test rather than a deployment.
 */
export function assertRegistryIsSound(registry: RouteRegistry): void {
  const seen = new Set<string>();
  for (const route of registry.routes) {
    if (seen.has(route.path)) {
      throw new Error(
        `Route ${route.path} is registered twice; each path belongs to exactly one entry.`,
      );
    }
    seen.add(route.path);

    if (route.kind === 'guarded' && route.action.trim() === '') {
      throw new Error(
        `Route ${route.path} is guarded but names no action to check.`,
      );
    }
  }
}

/**
 * Resolves the context for a request.
 *
 * Identity comes from the verified token, and only from there. A header, query
 * parameter or body field claiming an email, subject or workspace is data about
 * what the caller wants, not about who they are, so it is never read here.
 */
export function contextFromRequest(
  identity: VerifiedIdentity | null,
  searchParams: URLSearchParams,
): RequestContext {
  // The workspace travels as a query parameter, but only as a request about
  // which workspace is wanted. authorize resolves what that person may actually
  // reach, so a tampered value produces a denial rather than a wider scope.
  return {
    identity,
    workspaceId: searchParams.get('workspace_id'),
  };
}

/** The 401 for an unauthenticated request. */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Bạn chưa đăng nhập.', code: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** The 403 for an authenticated request that lacks permission. */
export function forbidden(message: string): Response {
  return new Response(JSON.stringify({ error: message, code: 'forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
