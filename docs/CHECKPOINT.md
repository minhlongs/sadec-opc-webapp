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

**No screen exists.** `src/main.ts` writes one string into `#root`. No route of
either area — catalog, inquiry, quote, order, deposit, delivery, follow-up, or
anything in the founder area — is reachable in a browser. The two domains in §2
have shape in the schema, not in the UI.

## Gates as last run

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS — 0 errors |
| `pnpm test` | PASS — 84 tests across 6 files |
| `pnpm build` | PASS — exit 0 |
| `pnpm test:e2e` | PASS — 2 tests, renders at 390px and 1440px |

The 84 is counted, not assumed: 8 + 14 + 20 + 19 + 15 + 8 `it()` blocks across
`money`, `economics`, `authorize`, `api-registry`, `require-environment` and
`verify-access-token`, with no `it.skip` or `it.only` anywhere. A test run that
reports fewer than 20 tests fails on purpose, so a collection error cannot look
like a pass.

## Next

1. Phase 1 — the vertical slice. One flow end to end in the browser: an
   operator logs in through Access, reads a catalog, and the request travels the
   full path through the chokepoint that phase 0 built. This is the gate before
   parallel lanes open, because a lane that cannot demonstrate its route loads
   in a browser has not proven the shared surface works.
2. Phase 2 and phase 3 in parallel once phase 1 passes, with strict file
   ownership: `src/ops/**` and `src/founder/**` respectively.

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
`rm -rf .wrangler/state && pnpm db:migrate:local && pnpm db:seed:demo`.
