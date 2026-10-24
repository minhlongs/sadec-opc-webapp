/*
 * The Worker entry.
 *
 * Phase 0 provides only a health route. The fail-closed auth middleware and the
 * authorization chokepoint land here next, before any business route, so nothing
 * is ever written reachable-but-unguarded.
 */

const startedAt = new Date().toISOString();

/**
 * Reports build identity without describing the authentication scheme. Routes
 * that expose configuration belong to nobody; this reports only what is safe to
 * publish and nothing about how a request might be forged.
 */
function handleHealth(): Response {
  return new Response(
    JSON.stringify({ status: 'ok', started_at: startedAt }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return handleHealth();
    }
    return new Response('Not found', { status: 404 });
  },
};
