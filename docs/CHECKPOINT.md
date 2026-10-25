# Checkpoint

What is true today, what comes next, and what is actually blocked. Written so
that a session with no memory can pick the work up from this file alone.

Updated after each phase. Read `docs/RELEASE.md` for what has been deployed and
`docs/DECISIONS.md` for why the code looks the way it does.

## Status

Phase 0 (foundation and contract) is complete and pushed on
`feat/sadec-flow-part-a`. Commands, environment guard, domain money arithmetic,
the §13 economics calculation, the authorization chokepoint, the route registry
and the Access token verifier exist and are tested.

Phase 1 (the vertical slice) is implemented on `feat/sadec-flow-part-a` and
verified locally. A React 19 app shell renders at 390px and 1440px, a global DEMO
banner announces the environment, and one operator flow runs end to end in the
browser: the operator reads a catalog and its customers, composes a quote draft,
saves it, and reads it back with the **server-computed** total. The route travels
the full path through the chokepoint phase 0 built.

`/api/session` lets the browser learn which workspace it may work in **without
naming one** — see `docs/DECISIONS.md` for why the workspace comes from the
membership table rather than from the request.

Three defects that passed all of the above while making a deployment refuse
everyone have been closed: the Worker never built a verifier from its
environment, the origin guard demanded a header a browser cannot send, and the
pilot deploy read a generated config with no database binding and no `APP_ENV`.
The browser save is now proven end to end at 390px. See `docs/RELEASE.md` for the
reproduction of each, and `docs/DECISIONS.md` for the reasoning.

**Still nothing is deployed.** No pilot URL exists, so §17's "unauthorized
visitors are blocked" has not been verified on a real route; the local checks
below are about the code, not about a live edge. Read `docs/RELEASE.md`.

## Gates as last run

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS — 0 errors |
| `pnpm test` | PASS — 145 tests across 10 files |
| `pnpm build` | PASS — exit 0 |
| `pnpm test:e2e` | PASS — 4 tests, renders at 390px and 1440px |

The 145 is counted, not assumed: 8 + 14 + 3 + 12 + 20 + 19 + 21 + 15 + 8 + 25
`it()` blocks across `api-registry`, `authorize`, `deploy-config`,
`dev-identity`, `economics`, `money`, `ops-routes`, `require-environment`,
`verify-access-token` and `worker-auth`, with no `it.skip` or `it.only`
anywhere. A test run that reports fewer than 20 tests fails on purpose, so a
collection error cannot look like a pass.

## Next

1. Phase 2 — `src/ops/**`: the rest of the nursery pipeline (customer inquiry,
   quote revisions that are immutable once published, order, deposit
   confirmation, delivery schedule, follow-up).
2. Phase 3 in parallel with phase 2, with strict file ownership
   (`src/founder/**`): interview and observation, change proposal, config
   version with rollback, OPC economics, contracts and pilot credit.
3. A workspace switcher, if phase 2 or phase 3 produces an identity that works
   in more than one workspace. `/api/session` picks the earliest-granted one
   deterministically today; nothing depends on that choice being permanent.

## Blocked

Nothing in the repo. Two items are external:

- **No `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` value exists yet.** They come from
  the Cloudflare dashboard and nobody has entered them. A deploy without them
  fails closed on every route, which is the intended behavior, but it means
  access cannot be verified on a real URL until they exist.
- **The GitHub token used here has `d1 (write)` but not `access`.** So this
  session can create databases and apply migrations, but cannot create or
  inspect the Access application that issues the tokens. §17's "unauthorized
  visitors are blocked" claim cannot be verified by this session alone; it needs
  someone with account access, and the steps are written out in
  `docs/RELEASE.md`.

## Reproducing a problem

`pnpm verify` runs typecheck, tests and build and reports each. If it fails,
read which of the three failed before changing anything — the guard fails a test
run that collected fewer than 20 tests, so a short run is a setup problem rather
than an assertion failure.

Local database state lives in `.wrangler/` (gitignored). If a migration behaves
differently after a schema edit, the local database is stale:
`rm -rf .wrangler/state && pnpm db:migrate:local -- --env demo && pnpm db:seed:demo -- --env demo`.
