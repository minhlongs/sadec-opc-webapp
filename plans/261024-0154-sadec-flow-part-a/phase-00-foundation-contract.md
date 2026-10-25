---
phase: 0
status: pending
owner: integrator
parallel_safe: false
---

# Phase 0 — Foundation and contract

Everything here is single-owner. No lane runs in parallel during this phase,
because the whole point is to make the shared surface immutable before anyone
builds on it.

## Context

Part A of `/Users/macbook/SADEC_OPC_SUPER_MASTER_PROMPT.md`. The repo already
exists and is tracked (1,791 files, mostly the engineer kit under `.claude/`), so
this phase extends it rather than scaffolding over it. The worktree is
`/Users/macbook/projects/sadec-opc-wt-part-a` on branch `feat/sadec-flow-part-a`.

## Requirements

1. A single pnpm app. No workspace file, no multi-package split — §3 says one
   repo, one app, one API.
2. `wrangler.jsonc` declaring the assets binding and `run_worker_first:
   ["/api/*"]`. The assets binding is written explicitly rather than left for the
   Vite plugin to infer, so it is visible what the router will do.
   `run_worker_first` is a routing instruction only. It protects nothing on its
   own, and that must be written into `docs/DECISIONS.md` so nobody mistakes an
   expanded glob such as `/api/public/*` for a security bypass.
3. One migration `migrations/0001_init.sql` covering every entity in §14, with
   `workspace_id` on tenant tables, `version` columns where §11 needs optimistic
   concurrency, foreign keys, and the uniqueness constraints that make the money
   invariants enforceable.
4. Three D1 bindings named `sadec-demo`, `sadec-test`, `sadec-pilot`. Local
   development uses a persistent state directory, not in-memory, so §3's
   "durable local database" holds. Wrangler selects a database by binding name,
   so all three are declared in the one config file rather than inferred from
   which database happens to exist.
5. **A single authorization chokepoint, `src/security/authorize.ts`, written in
   this phase and owned by nobody else.** Every route resolves identity, role and
   `workspace_id` through it, and no lane calls any other function that answers
   "may this identity do this". There is one way to answer that question, so one
   review covers every route.
6. **The auth middleware is fail-closed by default, in this phase — not deferred
   to phase 5.** Routes mounted under `/api/*` must resolve an identity, or they
   return 401. A route becomes reachable only by being explicitly registered as
   public, never by forgetting to attach a guard. Any route that writes also
   verifies request origin. A test asserts, against the route registry rather
   than per-behaviour, that every route is in exactly one set: declared public,
   or guarded.
7. `src/domain/money.ts` — integer VND, basis points for rates, and guards that
   reject negatives, NaN, and overflow. The server computes every total; no
   total is ever read from a request body.
8. `src/domain/economics.ts` — one function implementing all §13 formulas, plus
   a unit test per spec row. These three rows are the only pre-verified oracle in
   the spec, so they are written first and act as the regression net for phase 3.
9. `src/domain/rounding.ts` — the single rounding rule decided this phase.
10. `src/shared/schema.ts` — Zod schemas for every entity and API payload. Agent-
    supplied and import data is untrusted; escape on display, and never execute or
    interpret note content as instructions.
11. **The JWT verifier is tested here, in the phase that writes it — not first at
    phase 5's live `curl`.** Six cases at minimum: a valid token yields an
    identity; wrong `aud` is refused; wrong `iss` is refused; an expired token is
    refused; a signature from a key absent from the JWKS is refused; a `kid` that
    matches no published key is refused. The live check at phase 5 confirms the
    configuration and never substitutes for these.
12. **A missing `FOUNDER_EMAIL` is fail-closed like the other secrets.** If the
    configured founder identity is absent, empty or malformed at deploy time, every
    `/api/*` route fails closed and the bootstrap script exits non-zero naming the
    missing variable. No code path grants `founder_admin` to the first person who
    logs in, and none grants it because a variable is absent. §6 forbids the
    first-login shortcut in words; this phase makes it impossible.
13. **Import limits are enforced server-side, not merely displayed.** §12 asks
    that limits be shown before upload, and this phase additionally rejects an
    oversized body and an over-limit observation count before any apply. One
    import applies entirely or not at all.
14. **A shared environment guard for every command that touches a database.**
     `db:migrate`, `db:backup`, `db:restore:test`, `db:seed:demo` and
     `deploy:preview` all resolve their target through one helper rather than
     each script choosing its own default. The helper prints the target name,
     accepts an explicit environment flag only, and exits non-zero without
     touching anything when the flag is missing or names the wrong environment
     kind. `db:restore:test` accepts only a binding whose name ends in a test
     marker. §14 forbids silent fallback to another database, and a restore
     that lands on the wrong database destroys the evidence it was meant to
     prove.
15. `pnpm verify` — typecheck, lint, unit tests, build, and a check that the test
    count is greater than zero. Exit 0 with "no tests" is a failure, not a pass.
16. `.gitignore` extended for `.wrangler/`, `*.sqlite*`, `backups/`,
    `interviews/real/`, and `.dev.vars*`. §12 forbids real interview notes in
    git; `.dev.vars` holds the AUD tag, the team domain and the founder email, and
    a leaked AUD tag is a leaked ability to forge a valid JWT assertion.
17. `docs/DECISIONS.md` recording the rounding rule, the auth approach, and why
    the repo tracks `.claude/`.
18. `CLAUDE.md` describing the commands, the money boundary, and the rule that
    only the integrator writes migrations or merges.
19. `docs/ACCEPTANCE-CLICKTHROUGH.md` started now, not at the end. The winning
    advice explicitly disagreed with deferring it, and that disagreement is
    recorded rather than overridden.
20. **Every file and command §17 lists has an owner in this phase.** The
     foundation phase creates `README.md`, `.env.example`, the package script
     set (`dev`, `build`, `typecheck`, `test`, `test:e2e`, `db:migrate:local`,
     `db:seed:demo`, `db:backup`, `db:restore:test`, `deploy:preview`) and
     `examples/` with the interview import fixture and CSV template. No command
     is written into the README before it exists, which is §17's own rule, not an
     extra one.
21. **The demo seed is owned here and written early.** It carries two workspaces,
     twelve to twenty products, quotes in several states, orders and deposits, and
     three to five sample interviews, and it is idempotent so re-running never
     overwrites hand edits made during a demo. Phase 4 cannot evidence the
     end-to-end journey or capture screenshots without it, and no phase between
     here and there provides it.
22. **`docs/PRODUCT.md` and `docs/DISCOVERY.md` have owners.** The first belongs
     with the verification phase as the record of what actually shipped; the second
     belongs with the discovery phase, since it documents the interview, import,
     evidence-classification and proposal flow that phase builds.


## Files

Owned outright by the integrator through phase 4. Lanes read these and never
write them:

- `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`
- `wrangler.jsonc`, `.gitignore`, `vite.config.ts`
- `migrations/**`
- `src/shared/**`, `src/domain/money.ts`, `src/domain/economics.ts`,
  `src/domain/rounding.ts`
- `src/security/authorize.ts` and the auth middleware — the single chokepoint.
  Lanes call it and never write their own role check.
- `docs/DECISIONS.md`, `docs/RELEASE.md`, `docs/CHECKPOINT.md`
- `scripts/db-backup.*`, `scripts/db-restore-test.*`, and the shared
  environment guard they use. These are foundation-phase files, not
  deploy-phase files, so the restore case can be evidenced at phase 4.
- `scripts/verify.*`

Lane-owned once phase 2 starts:

- lane A: `src/ops/**`, `test/ops/**`
- lane B: `src/founder/**`, `test/founder/**`
- lane C: `src/worker/**`, `src/auth/**`, `scripts/db-*`, `scripts/deploy-*`

## Steps

1. Install the stack pinned to the versions resolved in research:
   `hono@4.13.13`, `zod@4.6.7`, `vite@8.3.5`, `@cloudflare/vite-plugin@1.65.0`,
   `react@19.3.1`, `react-dom@19.3.1`, `typescript@7.0.2`, `vitest@5.0.5`,
   `@playwright/test@1.64.1`, `jose@6.2.13`, plus a local `wrangler` matching the
   plugin's peer requirement. `@vitest/cloudflare` no longer exists, so D1 tests
   run against a local D1 database rather than a Workers pool.
2. Write the migration, then apply it locally and confirm the three databases are
   distinct.
3. Write `money.ts` and `rounding.ts` with their unit tests before any UI exists.
4. Write `economics.ts` plus the three §13 rows as tests. Run them; all three
   must match the values recorded in `plan.md`.
5. Write `schema.ts` and the auth skeleton, including the JWT verifier for
   `Cf-Access-Jwt-Assertion` and the dev identity adapter gated to local/test
   only.
6. Wire `pnpm verify` and confirm it fails loudly on a zero-test run.
7. Start the acceptance click-through document as a skeleton.

## Validation

- `pnpm typecheck` exits 0.
- `pnpm test` runs a non-zero number of tests and reports the count.
- The three §13 cases pass against the shared domain function.
- `pnpm build` exits 0 with no `:any` and no `console.log` in production code.
- The dev adapter cannot be enabled by a query string, cookie, request header, or
  a client-supplied role. Attempt it with a test that expects rejection.
- `pnpm db:migrate:local` reports which database it targeted.

## Risks and rollback

The largest risk is picking a rounding rule that §13 cannot reproduce. Mitigate
by writing the three spec rows as tests in this phase; a wrong rule fails here
rather than in the economics UI. Rollback is a `git revert` on this branch —
nothing has been pushed to `main`.

## Out of scope here

UI, routes beyond a health check, seed data, and anything in phase 2 or 3.
