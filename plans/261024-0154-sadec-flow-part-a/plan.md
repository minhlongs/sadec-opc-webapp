---
status: draft
created: 2026-10-24
branch: feat/sadec-flow-part-a
source_spec: /Users/macbook/SADEC_OPC_SUPER_MASTER_PROMPT.md
advisory_record: ./ultra-verdict.md
ship_mode: stable
---

# Sa Đéc Flow — Part A delivery

Build Part A of the spec as a working webapp in the existing worktree, then
deploy it as a private preview behind Cloudflare Access. Full Part A scope is in
scope: nothing in §4–§15 is deferred or cut. Where the winning advice proposed a
simplification, this plan records why it was not taken.

## Accepted outcome

A single pnpm app (not a workspace — the repo has no workspace file, so the
startup hook's "monorepo" label does not apply) with React + TypeScript + Vite,
a Hono API on Cloudflare Workers behind Static Assets, and D1 for persistence.
Two areas: nursery operations and Founder discovery. Three roles. Three separate
databases (demo, test, pilot). Deployed to the Cloudflare account named in the
deployment environment, as a private preview behind Worker-level Access, with no
domain purchase. The account, team domain, AUD tag and founder email live in
environment configuration and the dashboard, never in the plan files.

## Confirmed decisions the plan must not reverse

| Decision | Source |
|---|---|
| Build full Part A scope before any interview | founder |
| React + Vite + Hono on Workers, D1, Zod, pnpm | §3 |
| Multiple parallel agents plus one integrator | founder |
| Three separate D1 bindings: demo / test / pilot | §6, §14 |
| No domain, no public launch | founder |
| Acceptance evidence must be readable by a non-code-reader | founder |
| VND is integer; totals are computed server-side | §7.2 |
| Money rules and config versions are enforced, not advisory | §7, §11 |
| No PASS for a verification that did not run | §15 |

## Phases

| Phase | File | Owner | Outcome |
|---|---|---|---|
| 0 | `phase-00-foundation-contract.md` | integrator | Scaffold, single migration, contracts, authorization chokepoint, fail-closed middleware, JWT verifier and its rejection tests, guard helper for database commands, backup/restore scripts, demo seed, `pnpm verify`, every §17 file and command |
| 1 | `phase-01-vertical-slice.md` | integrator | One workspace slice that survives a server restart |
| 2 | `phase-02-ops-transactions.md` | lane A | Quote revisions, orders, receipts, delivery, follow-up, Today page, search, printable quote with DEMO label |
| 3 | `phase-03-founder-discovery.md` | lane B | Interviews, observations, proposals, config versions, economics, OPC ledger |
| 4 | `phase-04-verification-gates.md` | integrator | All 17 §15 cases evidenced, acceptance doc, backup/restore |
| 5 | `phase-05-private-preview.md` | lane C + founder | Pilot Worker+D1, Access allowlist, live auth check |

Dependencies: 2 and 3 both depend on 1. 4 depends on 2 and 3. 5 depends on 4.

## File ownership boundaries

Parallel lanes touch no shared file. The shared surfaces are single-owner and
remain the integrator's throughout phases 2 and 3:

- `migrations/**` — a lane that needs a schema change requests it; only the
  integrator writes the next numbered file. File ownership and migration
  ownership are separate boundaries: no lane edits any migration, including
  one it uses.
- `src/shared/**`, `src/domain/money.ts`, `src/domain/economics.ts`,
  `src/domain/rounding.ts`, `src/security/authorize.ts`, and the auth
  middleware and route registry.
- `src/ui/shell/**` — layout, Vietnamese typography, the design tokens from
  §5, and the shared loading/empty/error components. Lane A owns
  `src/ui/ops/**` and lane B owns `src/ui/founder/**`; neither edits the
  shell. A shell change is requested, not made.
- `wrangler.jsonc`, `package.json`, the lockfile, `docs/DECISIONS.md`,
  `docs/RELEASE.md`, `docs/CHECKPOINT.md`.
- `plans/**` is tracked; `plans/*/reports/` and `plans/**/*.local.md` are not.
Lanes 2 and 3 run in parallel after phase 1 is green; they never share a file.

## Verified facts this plan is built on

Confirmed against Cloudflare's published docs in this session, not assumed:

- The Worker must validate `Cf-Access-Jwt-Assertion` itself. Static Assets run
  behind an internal router Worker that does **not** pass `ctx.access` to the
  user Worker, so `ctx.access.getIdentity()` is unavailable. JWKS lives at
  `https://<team-domain>.cloudflareaccess.com/cdn-cgi/access/certs`; check `iss`,
  `aud`, `exp`, and match the token's `kid` against `public_certs` because keys
  rotate every six weeks with old keys accepted seven more days.
- Worker-level Access with scope "All traffic" covers routes, custom domains,
  the `workers.dev` hostname, and previews. Setting `workers_dev: false` does not
  disable Preview URLs or Version URLs, so Access — not a config flag — is the
  control that closes §15.17.
- The Cloudflare token can create D1 databases and deploy Workers (`d1 write`,
  `workers_scripts write`, `workers_routes write`, `pages write`), verified by a
  successful `wrangler d1 list` over 30 existing databases. The token has **no**
  `access` scope, so creating the Access application is a founder dashboard task,
  not an agent task. The token is an OAuth credential with a refresh token, so it
  expires and renews; if it ever fails to renew, phase 5 becomes blocked rather
  than misconfigured.
- Spec §13's three economics cases were recomputed and match to the dong:
  N=5 → 15,000,000 / 4,250,000 / 10,750,000 / 92h / 13,800,000 / −3,050,000;
  N=10 → 30,000,000 / 6,000,000 / 24,000,000 / 112h / 16,800,000 / 7,200,000;
  N=10,S=2 → 50,000,000 / 7,000,000 / 43,000,000 / 160h / 24,000,000 /
  19,000,000. These are the oracle for phase 3.
- Playwright 1.64.1 Chromium is installed and launches (Chromium
  156.0.8078.4), so §15 cases 1, 2 and 16 are not blocked.
- The pnpm toolchain is available on this machine (12.14.0) but has never been
  run in this repository: there is no `package.json` yet, so "uses pnpm" is a
  decision, not a verified fact. Phase 0 makes it real by creating the lockfile.

- Version floor for this app: `@cloudflare/vite-plugin@1.65.0` requires peer
  `wrangler@^4.152.0`, which conflicts with the global 4.129.0. Wrangler is
  installed as a local devDependency.

## Open items that block specific work

1. **Rounding rule for the one non-integer metric.** §7.2 requires integer
   VND, and exactly one §13 output is not an integer: the first-year average
   cost, 3,833,333.33. Every other §13 output is integer, including the
   three verification rows, which were recomputed and match to the dong. So
   this is one displayed row, not a gate on the acceptance evidence. The
   target-benefit row lands on exactly 11,500,000, so the fractional part
   disappears there anyway. Phase 0 picks one rule and records it; the
   recommendation is truncating to the dong, because it is reversible and
   keeps §13 reproducible.
2. **Deposit policy definition.** §7.3 blocks over-payment but §10 requires pilot
   credit to reduce an obligation. Phase 2 must fix the order: credit applies
   first, then the over-payment check.
3. **Who may write OPC obligations.** §6 assigns agreements to `founder_admin`
   but is silent on obligation and receipt allocation. Phase 3 must decide
   before any route is written.

Items 1 and 2 are engineering calls the integrator can make and record. Item 3
is listed here because it changes authorization, and authorization is the part
the founder cannot check by clicking.

## Non-goals

Marketplace, ERP, wallet, tax/accounting, native mobile, OCR, LLM, real
Zalo/email/payment integration, generic rules engine, scheduled config
effective dates, decimal quantities, subscription-period auto-generation, domain
purchase, public launch.

## Progress log

- 2026-10-24 — Advisory run closed, winner recorded with one corrected
  technical claim (see `ultra-verdict.md`). Worktree and branch created. Repo
  pushed to `github.com/minhlongs/sadec-opc-webapp` as private.

## Red-team outcome

Four adversarial personas reviewed the plan before implementation. All findings
are resolved in the phase files rather than deferred:

- **Failure modes** — every database command resolves its target through one
  guard that prints the target and refuses a missing or wrong environment kind.
  Backup and restore moved to the foundation phase, removing a cycle where the
  restore case could not be evidenced until deploy work had merged. Membership
  grants are documented commands with audit and a wrong-workspace refusal. The
  pilot's empty-start rule and the live journey are reconciled by ordering.
- **Security** — the authorization chokepoint and fail-closed middleware moved
  from the deploy phase to the foundation phase, so no route is written before
  it is guarded. The JWT verifier has six rejection tests in the phase that
  writes it. A missing founder identity fails closed with the other secrets.
  Import limits are enforced server-side. The diagnostic route exists only in
  development and returns a single boolean.
- **Assumptions** — the pnpm claim is recorded as a decision rather than a
  verified fact, and the OAuth credential's expiry is noted. Isolation testing
  is split into routes with and without an `:id` parameter.
- **Scope** — the Today page, search, the unknown-price confirmation, the owner
  delivery exception, the surfaced refund obligation, the DEMO label on printed
  output, the demo seed, and the files and commands the delivery list names all
  gained owners in the phase files.
