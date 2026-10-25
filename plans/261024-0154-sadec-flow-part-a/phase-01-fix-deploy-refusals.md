---
phase: 1
status: completed
owner: integrator
depends_on: 0
parallel_safe: false
---

# Phase 1 repair — three deploy-only refusals

The vertical slice works locally and passes every gate, and then refuses on the
deployment it was built for. All three defects pass `pnpm verify` and all 140
tests, which is exactly the failure class CLAUDE.md names as this repo's
priority. This file records the repair before the edits, because two of the three
touch a control the earlier phase wrote deliberately.

## Defects, each proven before it was fixed

**No token verifier is ever wired to the Worker.** `accessTokenVerifier` in
`src/security/verify-access-token.ts` has no caller anywhere in `src/` or
`scripts/`. `verifier` is a module-level `null`, `setVerifier` is called only from
`test/worker-auth.test.ts`, and `resolveIdentity` returns `null` when it finds
`verifier === null`. On a pilot deployment `resolveDevIdentity` returns `null` too
(not local/test), so every guarded route refuses every caller — including the
founder — with a 401 that says nothing about the cause. Locally the dev adapter
supplies the identity, so the verifier is never consulted and the gap is invisible.

**Every same-origin save from a browser is refused.** `originMatches` requires an
`Origin` header on any mutation. `Origin` is a forbidden request-header name: the
browser sets it itself and silently drops it from a `fetch` init, so
`src/ui/api.ts`'s `mutationInit` cannot supply it. Verified in Chromium against
the live dev server: two same-origin POSTs to `/api/quote-drafts/save`, one with
`origin: location.origin` and one without, both arrived with no `Origin` header
and both would be refused; `Sec-Fetch-Site` was present. Confirmed with curl too —
no `Origin` → 403, correct `Origin` → 201 with `subtotal_vnd: 180000` from the
catalog. The tests pass because they construct `Request` objects and set the
header directly, which a real browser refuses to do.

**The pilot deployment resolves no database.** The deploy command runs
`wrangler deploy --env pilot`, which reads the config the Cloudflare Vite plugin
generates at `dist/sadec_flow/wrangler.json`. That file records
`"definedEnvironments":["pilot"]` but emits no `env.pilot`, no `vars`, and no
`sadec_pilot` — its `d1_databases` holds only the three top-level bindings.
`--dry-run` against that exact file lists `sadec_demo`, `sadec_test`,
`sadec_test_restore` and nothing else. So in pilot `databaseFor` returns null and
every guarded route refuses with a 403 that reads like a permission problem.

The unit tests inject their own store and binding map, so none of the three is
caught by `pnpm verify`.

## The second-order problem the third defect hides

A missing `vars` means the deployed Worker has no `APP_ENV`. `resolveDevIdentity`
treats an unknown environment as *not* development, so the dev-identity path is
correctly closed — but `BINDING_BY_ENVIRONMENT[undefined]` resolves to
`local`, so a route that reached the database lookup would read the *demo*
binding name. With the verifier wired (fix one) every guarded route refuses
anyway, so this is currently unreachable rather than live. It is fixed by
declaring the pilot environment rather than by repairing the lookup, so a
deployment states its own environment instead of defaulting to another one's.

## Repair

1. **Wire the verifier from the environment.** Build the verifier lazily inside
   `resolveIdentity` from `env.ACCESS_TEAM_DOMAIN` and `env.ACCESS_AUD`, cached per
   domain the way `keySetFor` already is. The module-level `let verifier` stays,
   because it is how tests substitute their own, but a deployment must not depend
   on someone calling `setVerifier` from outside. A partial configuration yields a
   verifier that refuses everything, which `accessTokenVerifier` already does.
2. **Check `Sec-Fetch-Site` instead of `Origin`.** Replace the origin comparison
   with a `Sec-Fetch-Site: same-origin` check. A browser sends that header on
   `fetch` and on navigation, and a page cannot forge it, so it keeps the
   cross-site control the origin check was written for while letting a
   same-origin mutation through. `Sec-Fetch-Site` is set by the browser on every
   request it makes, including `fetch` from a page. `none` (a user typing a URL)
   is accepted for reads, and refused for mutations, matching the previous
   behaviour for a request with no `Origin` at all.
3. **Make the deploy config carry the pilot environment.** Declare the pilot
   environment so the generated config includes it. This is verified by asserting
   on the generated file's contents rather than by trusting the deploy command,
   because the deploy refuses to run without the Access secrets and that is the
   correct refusal.
4. **Make the verifier's type match its implementation.** `accessTokenVerifier`
   returns an async function; `Verifier` and the test helper are both synchronous.
   Wiring a real verifier through a synchronous type would compile to a Promise
   that every truthiness test treats as success — a refusal path that looks like a
   success. The route awaits it.

## Files

- `src/worker/index.ts` — verifier construction, `resolveIdentity`, origin check
- `src/worker/api.ts` — if the `Verifier` type is shared
- `test/worker-auth.test.ts` — the three origin tests and any new verifier cases
- `scripts/` — the assertion over the generated deploy config
- `docs/DECISIONS.md`, `docs/RELEASE.md`, `README.md`, `CLAUDE.md` — to state what
  is now proven and what is still not deployed

## Validation

- A browser saves a quote draft and reads it back, with no `Origin` header the app
  had to fake — this is the flow the phase exists to prove.
- A unit test asserts a mutation with no `Sec-Fetch-Site` is refused, and one with
  a foreign value is refused, so the control is still exercised.
- A test asserts the pilot environment resolves its own database binding and its
  own `APP_ENV`, so a config that loses the environment fails a test rather than a
  deployment.
- `pnpm verify` green, `pnpm test:e2e` green at both widths.

## Risks

Fix two removes a check a previous phase wrote on purpose, so it is recorded here
rather than in a commit message. It keeps the cross-site refusal by different
means. The deploy config assertion is a build-artifact test: it reads a file the
build generates, so it fails if the build layout changes, which is the point.

## Gate

The three refusals are closed before this phase is called green. Nothing is
deployed in this repair, so a real URL remains unverified and `docs/RELEASE.md`
keeps saying so.
