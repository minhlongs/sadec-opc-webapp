---
phase: 1
status: pending
owner: integrator
depends_on: 0
parallel_safe: false
---

# Phase 1 — One vertical slice that survives a restart

This phase exists to prove the whole pipe works before anyone builds sideways on
it. It is deliberately small and deliberately still single-owner.

## Context

§16 Phase 1 asks for app shell, API, durable local database, local identity, one
workspace, product and customer, and a saved quote — with persistence checked in
a browser *before* any dashboard polish. The winning advice adds a hard gate: no
lane is opened until this slice is green.

## Requirements

1. App shell renders at 390px and 1440px with the light, low-saturation palette
   from §5 (`#F6F5F0`, `#155E48`, `#D99C25` as a starting point) and a
   Vietnamese-first interface.
2. A persistent DEMO banner that is global state, not a per-page copy — §5
   requires it continuously and §12/§13 depend on synthetic data never being
   read as real.
3. One workspace, one founder identity, products and customers with real CRUD,
   and a quote draft that can be saved.
4. Every business record lives in D1. `localStorage` may hold UI preferences
   only and is never the sole source of business data (§3).
5. Persistence across a full server restart is verified, not assumed (§15 case 2).

## Files

- `src/ops/**` (product, customer, quote draft only — no revisions yet)
- `src/worker/**` (routes, auth middleware, error envelope)
- `src/ui/**` (shell, two breakpoints, loading/empty/error states)
- `test/**`

Phase 0's files stay owned by the integrator. If this phase needs a schema
change, the integrator writes a new migration; it never edits `0001`.

## Steps

1. Stand up the Hono app behind the assets binding with `run_worker_first:
   ["/api/*"]` so API requests reach the Worker regardless of asset matching.
2. Build product and customer CRUD end to end: route → Zod validation → D1 →
   response. Server computes every derived value.
3. Build the quote draft save. No issue or revision yet; that is phase 2.
4. Build the shell with the five required states — loading, empty, error,
   success, offline — and confirm a failed API call does not wipe a form (§5).
5. Add a `/api/whoami` route that reports whether `ctx.access` is present, to
   settle empirically what the published docs describe: whether the Static Assets
   router Worker forwards `ctx.access` to the user Worker. This is the check the
   winning advice asked for and the runner-up candidate left open. Record the
   observed result in `docs/DECISIONS.md`.
   **The route is a development instrument, not a product feature.** It is
   registered only when the environment is development, so it does not exist in a
   deployed build — a deployment returns 404 for it, and phase 5 asserts that as
   one line of case 17 alongside the inert dev-identity endpoint. When it does
   exist it returns a single boolean about `ctx.access`, never a header, `sub`,
   email, team domain, AUD tag or role. It must not become a description of the
   pilot's authentication scheme available to an unauthenticated caller.
6. Run the dev server, create records through the UI, restart the server, and
   confirm the records are still there. Capture the evidence.

## Validation

- §15 case 2 passes: records created through the UI survive a server restart.
- The pipeline `pnpm dev` → DB → UI works from the README on a clean checkout.
- 390px and 1440px both render without a broken layout; no `console.error` on the
  main path.
- The dev identity adapter is visibly labelled as demo identity (§6) and cannot
  be activated by anything a client controls.
- The observed `ctx.access` result is written down, whatever it is.
- The auth middleware is fail-closed at this phase, not deferred: no
  unprotected `/api/*` route exists, the route-registry test passes, and
  every write route rejects a mismatched origin. This is the phase-0
  requirement, verified here rather than at phase 5.

## Risks and rollback

The `/api/whoami` probe may show `ctx.access` present, which would contradict the
published docs. If that happens, record it with the exact wrangler and plugin
versions rather than adjusting the plan — but keep the JWT verifier anyway, since
it remains correct when the header is present and the router changes underneath.

## Gate

No lane opens until this phase is green. If the persistence check fails, stop and
diagnose; do not fan out work on a pipe that leaks.
