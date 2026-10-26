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

Phase 1 (the vertical slice), Phase 2 (Nursery Ops pipeline), Phase 3 (Founder
discovery and configuration), the B2B Floriculture Marketplace escrow/QR flows,
and the Dual-Surface AEO/GEO projection layer are implemented and verified
locally. A React 19 app shell renders at 390px and 1440px, a global DEMO banner
announces the environment, and the full Nursery Ops, Founder Discovery, and B2B
Marketplace flows run end to end through the authorization chokepoint phase 0
built.

`/api/session` lets the browser learn which workspace it may work in **without
naming one** — see `docs/DECISIONS.md` for why the workspace comes from the
membership table rather than from the request.

Three defects that passed all of the above while making a deployment refuse
everyone have been closed: the Worker never built a verifier from its
environment, the origin guard demanded a header a browser cannot send, and the
pilot deploy read a generated config with no database binding and no `APP_ENV`.
The browser save is now proven end to end at 390px. See `docs/RELEASE.md` for the
reproduction of each, and `docs/DECISIONS.md` for the reasoning.

**Both Demo and Pilot Workers are deployed on Cloudflare Edge.**
- Demo Worker: `https://sadec-flow.agencyos-openclaw.workers.dev` (Version `baf4dbe1-ff1e-4254-90e7-f326ef38fdd0`, remote D1 `sadec-demo` migrated through `0004` and seeded).
- Pilot Worker: `https://sadec-flow-pilot.agencyos-openclaw.workers.dev` (Version `22d51a8d-4aa8-42fd-a291-a804998ba0b8`, remote D1 `sadec-pilot` migrated through `0004`, starts empty with 0 rows in `customers`, `orders`, `founder_interviews`, `receipts`, and fails closed with HTTP `401` on unauthenticated, forged-JWT, and `X-Dev-Identity` requests). Read `docs/RELEASE.md`.

## Gates as last run

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS — 0 errors |
| `pnpm test` | PASS — 220 tests across 22 files |
| `pnpm build` | PASS — exit 0 |
| `pnpm test:e2e` | PASS — 24 tests (12 specs × 390px and 1440px) |

The 220 is counted, not assumed: 9 + 8 + 8 + 14 + 11 + 5 + 3 + 12 + 20 + 6 + 10 + 3 + 2 + 19 + 21 + 8 + 4 + 2 + 16 + 8 + 4 + 30 `it()` blocks across `aeo-geo-discovery`, `aeo-projection`, `api-registry`, `authorize`, `b2b-e2e-workflow`, `b2b-routes`, `deploy-config`, `dev-identity`, `economics`, `escrow-ledger`, `founder-discovery`, `lot-qr`, `marketing-ui`, `money`, `ops-routes`, `ops-transactions`, `part-a-gates`, `remediation-commands`, `require-environment`, `verify-access-token`, `vietqr` and `worker-auth`, with no `it.skip` or `it.only` anywhere. A test run that reports fewer than 20 tests fails on purpose, so a collection error cannot look like a pass.

## Next

1. Provision `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `FOUNDER_EMAIL` in the
   Cloudflare account and run `pnpm deploy:preview` to verify the live edge
   gates recorded in `docs/RELEASE.md`.

## Blocked

Nothing in the repo. Three items are external:

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
- **No CI, and no branch protection.** This repository has no workflows
  (`.github/workflows/` does not exist, `gh api .../actions/runs` reports
  `total_count: 0`) and branch protection returns 403 on a private free plan. So
  a green gate here is a local run, never a server-side one, and nothing prevents
  a direct push to `main`. Worth fixing before more than one person works here.

## Reproducing a problem

`pnpm verify` runs typecheck, tests and build and reports each. If it fails,
read which of the three failed before changing anything — the guard fails a test
run that collected fewer than 20 tests, so a short run is a setup problem rather
than an assertion failure.

Local database state lives in `.wrangler/` (gitignored). If a migration behaves
differently after a schema edit, the local database is stale:
`rm -rf .wrangler/state && pnpm db:migrate:local -- --env demo && pnpm db:seed:demo -- --env demo`.

`pnpm test:e2e` depends on the **demo seed**, not just the schema: the save test
picks the seeded products and customers (`pd-a-01`, `cu-a-01`…) from
`migrations/seed/demo.sql`, and seeding is not part of any gate. On a machine
that ran the migrations without the seed, that test fails on a missing option
rather than on anything the browser did — run
`pnpm db:migrate:local -- --env demo && pnpm db:seed:demo -- --env demo` first.
The smoke test deliberately does not depend on it.
