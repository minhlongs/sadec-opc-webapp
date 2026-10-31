# Release

What was actually run, and what it produced. A command is listed here only after
it ran on this machine; nothing below is aspirational. §17's rule: never put a
command in the README before it exists and matches the repo.

## Status

**Deployed at the date recorded below. Not re-verified by the session that wrote
the phases A–G notes at the end of this file: that session ran locally only and
made no deployment, no remote migration and no Access change.**

**2026-10-31: `main` is `681b841` and CI is green on it; still nothing new was
deployed.** The full stack — migrations `0005`–`0007`, the founder bootstrap, the
B2B settlement obligations — is on `main` and has never run against a remote D1.
The two Workers below remain the `0004`-era versions named in
`docs/CHECKPOINT.md`; a deployment of `681b841` is an open step, not a
description of what is live. The session that merged it had no Cloudflare
credential (`wrangler whoami` → *not authenticated*), so no remote command ran and
the URLs could not be reached from its sandbox either.
- Demo & Preview Worker: `https://sadec-flow.agencyos-openclaw.workers.dev` (bound to remote D1 `sadec-demo`, seeded with demo catalog, B2B lots, and interviews)
- Pilot Worker: `https://sadec-flow-pilot.agencyos-openclaw.workers.dev` (bound to remote D1 `sadec-pilot`, empty start with 0 customers, orders, interviews, receipts, and fail-closed authentication)

## Environment

| Item | Value |
| --- | --- |
| Package manager | pnpm 12 (lockfile committed) |
| Node | see `engines` in `package.json` |
| Compat date | `2026-10-08` in `wrangler.jsonc` |
| Branch | `main` |
| Remote | `https://github.com/minhlongs/sadec-opc-webapp.git` (private) |
| Demo Worker | `https://sadec-flow.agencyos-openclaw.workers.dev` |
| Pilot Worker | `https://sadec-flow-pilot.agencyos-openclaw.workers.dev` |
| Cloudflare Account | `f691e83094f776311a1bfe3f8b126f1c` (`agencyos-openclaw`) |
| Remote D1 `sadec-demo` | `1b48c45b-0a49-4c04-8449-52ae5e4219d7` |
| Remote D1 `sadec-pilot` | `5d2bd39f-93c0-400b-8207-586e17023cf2` |
| Remote D1 `sadec-test` | `e09c1540-aff0-406d-b5f5-7460f6d62ab6` |
| Remote D1 `sadec-test-restore` | `e8948bf6-a856-428f-b6ef-3d0c81d1943b` |

Four D1 bindings are declared in `wrangler.jsonc`: `sadec-demo`, `sadec-test`,
`sadec-test-restore` and `sadec-pilot`. They are separate by design — §3 requires
demo, test and pilot data never to mix, so a test that writes cannot reach the
demo database a customer is looking at. The pilot binding is declared at the top
level rather than under an `env.pilot` block, because the Cloudflare Vite plugin
drops the `env` object when it generates the config a deploy reads;
`test/deploy-config.test.ts` asserts on that generated file.

## Commands run locally, with results

Two tables follow, deliberately. The first is a record of an **earlier session**
and its counts (220 tests, 24 browser tests) are superseded; the second is the
run this branch's `HEAD` was verified with. Neither is a CI run, and neither
touches a deployment.

### Earlier session (superseded counts, kept as history)

| Command | Result |
| --- | --- |
| `pnpm install` | PASS, after `pnpm approve-builds esbuild workerd` |
| `pnpm typecheck` | PASS — 0 errors |
| `pnpm test` | PASS — 220 tests across 22 files |
| `pnpm build` | PASS — exit 0 |
| `pnpm test:e2e` | PASS — 24 tests (12 specs × 390px and 1440px) |
| `pnpm db:migrate:local -- --env demo` | PASS |
| `pnpm db:seed:demo -- --env demo` | PASS — idempotent, safe to re-run |
| `pnpm db:backup` | PASS |
| `pnpm db:restore:test` | PASS — restores into `sadec-test-restore` |
| `pnpm exec wrangler deploy --env pilot --dry-run` | PASS — resolves `sadec_pilot`, uploads nothing |

`db:restore:test` writes only to `sadec-test-restore`, and the script drops that
database's tables before replaying. No path in any script writes to
`sadec-demo` or the pilot database. `deploy:preview` is the only command that
touches the network, and it refuses to run until the Access configuration is
present.

## Deploy-only defects, and how each was proven

Three defects made the pilot refuse every request while `pnpm verify` passed and
all tests were green. Each was reproduced before it was fixed, because this class
of failure — passes locally, fails on the edge — is the one a repo organized
around a fail-closed authorization chokepoint cannot leave to a deploy.

| Defect | Reproduction before the fix |
| --- | --- |
| No token verifier was ever wired to the Worker | `accessTokenVerifier` had no caller in `src/` or `scripts/`; the only fill of the module slot was in the test file, so on a pilot deployment `resolveIdentity` found `verifier === null` and returned no identity |
| Every browser save was refused | Chromium issued two same-origin POSTs to `/api/quote-drafts/save`, one setting `origin: location.origin` and one not. Both arrived with no `Origin` header. `curl` with no `Origin` → 403; with the right `Origin` → 201 |
| The pilot deployment had no database | `pnpm exec wrangler deploy --env pilot --dry-run` listed `sadec_demo`, `sadec_test`, `sadec_test_restore` and no `sadec_pilot`. The config the deploy reads is the one the Vite plugin generates under `dist/`, and it carried no `env.pilot` at all |

After the fixes, driven through a real browser at 390px with the dev server
running: the operator flow completes a save and the server-computed total reads
`1.300.000 đ`, with no refusal and no console error. That figure is the one-off
observation below — a draft of `pd-a-03` × 2, the L-size pot at 650,000 đ. The
standing test asserts `360.000 đ` (`pd-a-01` × 2), so the two numbers are
different drafts rather than a disagreement. The unit tests never caught any of
the three because they inject their own store, binding map and verifier, and
construct `Request` objects with a header a browser will not send.

The detail of each repair is in `docs/DECISIONS.md`. The browser save is now a
standing check rather than a one-off proof: `e2e/quote-draft-save.spec.ts` drives
the form at both widths, asserts the total the **server** returned, and asserts
the row appears in the draft list — so the save proves it reached D1 rather than
only reaching the response. It also fails on a refusal, because the error panel
inside the form is asserted absent. It was written after the fixes and failed
twice before it passed: both workers wrote the same reference, and a re-run then
revealed that the schema holds one live draft per customer, so the test keys its
identity on the customer rather than on the reference.

## What blocks a deploy

> **Update, round 17.** The deploy no longer has to happen from the session that
> wrote the code. The owner's decision moved it to GitHub Actions: six manual
> workflows (`ops-preflight-pilot`, `db-backup-pilot`, `db-migrate-pilot`,
> `deploy-pilot`, `smoke-pilot`, `bootstrap-founder-pilot`), each taking a full
> SHA that must be on `main` with a green `verify` run, each holding its secrets
> from the `pilot` GitHub Environment. **None was dispatched, no Environment
> exists, and nothing was deployed or migrated.** The checklist is
> `docs/DEPLOY-VIA-GITHUB.md`; what is true today is in `docs/CHECKPOINT.md`. The
> blocker described below is unchanged in substance — the Access values and a
> token still have to come from the owner — but it is now satisfied on GitHub
> rather than in this sandbox.
>
> The preparation was shipped as PR #27: `pnpm verify` PASS — 532 tests across 42
> files locally, and the pull request's `verify` run
> [41202309032](https://github.com/minhlongs/sadec-opc-webapp/actions/runs/41202309032)
> green in 2 m 51 s with the browser suite included. Its first run had failed in
> seven seconds on a pinned action SHA that did not exist; that run proved nothing
> about the tree and is recorded as such in `docs/CHECKPOINT.md`.

`pnpm deploy:preview` exits 2 and deploys nothing when `ACCESS_TEAM_DOMAIN` or
`ACCESS_AUD` is missing. Both are currently missing, because only the Cloudflare
dashboard can supply them and nobody has entered them.

`FOUNDER_EMAIL`/`FOUNDER_SUB` were required by an earlier version of that command
and are not any more: no code read them, and access comes from
`pnpm bootstrap:founder`. A deploy grants nobody anything, which is why the
founder identity is an argument to a provisioning command rather than a Worker
setting.

That is the correct behavior rather than a failure: a Worker deployed without
them would refuse every request, and someone would diagnose an outage instead
of a missing setting.

## Live Edge Verification (§15 Case 17)

Both Workers (`sadec-flow` and `sadec-flow-pilot`) are deployed on Cloudflare Edge with remote D1 databases migrated (`0001_init.sql` through `0004_part_a_ops_and_founder.sql`). Preview URLs are disabled on `sadec-flow-pilot`.

Recorded live output against `https://sadec-flow-pilot.agencyos-openclaw.workers.dev`:

```bash
curl -sS https://sadec-flow-pilot.agencyos-openclaw.workers.dev/api/health
# -> {"status":"ok","env":"pilot"} (HTTP 200)

curl -sS -w '\nstatus: %{http_code}\n' https://sadec-flow-pilot.agencyos-openclaw.workers.dev/api/orders
# -> {"error":"Bạn chưa đăng nhập."}
# -> status: 401

curl -sS -w '\nstatus: %{http_code}\n' -H 'Cf-Access-Jwt-Assertion: not-a-token' https://sadec-flow-pilot.agencyos-openclaw.workers.dev/api/orders
# -> {"error":"Bạn chưa đăng nhập."}
# -> status: 401

curl -sS -w '\nstatus: %{http_code}\n' -H 'X-Dev-Identity: demo-admin' https://sadec-flow-pilot.agencyos-openclaw.workers.dev/api/session
# -> {"error":"Bạn chưa đăng nhập."}
# -> status: 401
```

Pilot database emptiness verified on remote `sadec_pilot` (`5d2bd39f-93c0-400b-8207-586e17023cf2`):
- `customers`: `0`
- `orders`: `0`
- `founder_interviews`: `0`
- `receipts`: `0`

Rollback commands:
```bash
pnpm exec wrangler rollback 33aae98b-ffc2-44d8-9e81-56e3bed70732 --name sadec-flow
pnpm exec wrangler rollback 0ab79a63-3e82-434d-b0f0-c40702ed29b2 --name sadec-flow-pilot
```

**One Cloudflare Dashboard step remains for interactive login on `sadec-flow-pilot`:** the OAuth token in use here has `d1 (write)` and `workers_scripts (write)` but not `access`. The founder needs to attach a Worker-level Cloudflare Access application in the Zero Trust dashboard and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` secrets on `sadec-flow-pilot` to allow authenticated browser login on the pilot URL, then run `pnpm bootstrap:founder` so an identity exists to log in as; until then, `sadec-flow-pilot` fails closed (`401`) on all non-public routes as designed.

**A CI workflow now exists but has not run.** `.github/workflows/verify.yml` was
added in the phases A–G session (see the notes at the end of this file) and its
content is asserted by `test/deploy-config.test.ts`; `gh api .../actions/runs`
reported `total_count: 0` when this section was written, before the file
existed. Read it as "CI is defined locally, unobserved on GitHub".

**At the time this section was written there was no CI.** There was no
`.github/workflows/` directory and `gh api .../actions/runs` reported
`total_count: 0`. That matters when reading a
merge: branch protection is also unavailable, because a private repository on a
free plan cannot enable it (`gh api .../branches/main/protection` answers HTTP
403). So nothing on the server re-runs typecheck, the 220 unit tests, the build or
the five browser suites, and nothing stops a push straight to the default branch.
Every green claim in this file was produced by running `pnpm verify` locally and
recording the output; it is not backed by a remote check.

## The pilot runbook, and the one step it cannot script

`docs/PILOT-RUNBOOK.md` is the operational procedure, including the step that
grants the first `founder_admin` (`pnpm bootstrap:founder`) and the SQL that
revokes a mistaken grant without erasing the audit trail: identify the account, read
`migrations list`, back up, migrate with the environment guard, deploy the Worker
the script names, then smoke-test public and authenticated behaviour, roles,
workspace boundaries, an unconfigured receiving account, and settlement
obligations as distinct from confirmed transactions. It also lists stop
conditions and what recovery cannot do.

The blocker recorded in the previous round is closed: the first membership is
created by a provisioning command, not by a deploy and not by a login. Deploying
granted nothing before and grants nothing now; `deploy:preview` no longer asks for
`FOUNDER_EMAIL`/`FOUNDER_SUB`, because no code ever read them.

## Phases A–G: what this session actually ran (local only, 2026-10-30)

Nothing was deployed, no remote database was migrated, no Access setting was
changed and no external message was sent. Everything below ran in a sandbox
against a local SQLite database under `.wrangler/`, with Chromium 153
(`@sparticuz/chromium`) standing in for Playwright's bundled browser because the
browser CDN was unreachable from the sandbox.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK |
| `pnpm db:migrate:local -- --env demo` | `0001`–`0006` applied to `sadec_demo` (upgrade path, existing rows kept) |
| `pnpm db:seed:demo -- --env demo` | demo seed applied |
| `pnpm db:migrate:local -- --env test` | `0001`–`0006` applied to an empty `sadec_test`, then `0007` applied alone as an upgrade; the upgrade path is also a test (`test/migration-0007.test.ts`) and part of the local drill in `docs/CHECKPOINT.md` |
| `pnpm bootstrap:founder -- --env test …` | preview wrote nothing; `--apply --subject-verified` created one workspace, identity, membership and provisioning audit row; a re-run reported `ALREADY`; a second founder was refused `founder_exists`; `--env demo` was refused by the guard |
| `pnpm verify` | PASS — typecheck, build, **405 tests across 37 files** on the release candidate (390/34 at the previous handover) |
| `pnpm test:e2e` | **48 passed** — 8 spec files × 390px and 1440px, two dev servers (`:5173` operator, `:5174` founder), the suite's own database at `.wrangler/e2e-state` reset to the seed first. Run eight times on 2026-10-30; the last two from a clean clone of the handover bundle |
| clean clone of the bundle | `pnpm install --frozen-lockfile`, `pnpm verify`, two browser runs, then `db:migrate:local` + `bootstrap:founder --apply` — all without a secret or state file from this workspace. The counts for the current bundle are in `sadec-flow-handover.manifest.md`, beside it |
| `pnpm exec tsc --noEmit` alone | Not a gate. It passed while `test/agent-bridge.test.ts` read a field off the wrong branch of a union; `pnpm verify` caught it. Recorded because a manual command is not the gate |

Evidence collected during those runs (not asserted above, recorded so a later
session can tell a real run from a plausible one):

- A quote chain created through `/api/quote-chains/create` and issued, accepted
  from the UI: the audit row `quote.accepted` names `id-demo-operator`, and the
  order's `deposit_required_vnd` is 30% of the total, computed by the server.
- The founder import applied through the UI wrote exactly one
  `founder.interviews.imported` audit row for the batch, and the preview before
  it wrote none.
- Reverting `src/ui/agent-bridge.ts` to the handed-off version made
  `test/agent-bridge.test.ts` fail with four invented lots and a fabricated
  revision string, which is how the fabrication was proved rather than argued.
- 40 concurrent receipt writes split across the two dev servers returned 40 ×
  `201` with no `SQLITE_BUSY`. That is a **probe, not a root cause**: the lock
  errors were never traced. The claim "resetting the database fixed them" is
  withdrawn; what the harness actually removed is stale-server reuse and shared
  fixtures, and the reset survives only because specs book real stock
  (`docs/CHECKPOINT.md`, `docs/DECISIONS.md`).
- The B2B booking screen showed the "no receiving account configured" notice —
  the state of this deployment, since no `ESCROW_*` value is set anywhere.

What remains unverified, and needs someone with account access: the live Worker
URLs, Cloudflare Access behaviour on the pilot hostname, a remote migration
through `0007`, the bootstrap against a remote database, and any payment leg
(there is no configured account and no bank integration).
