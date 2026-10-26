# Release

What was actually run, and what it produced. A command is listed here only after
it ran on this machine; nothing below is aspirational. §17's rule: never put a
command in the README before it exists and matches the repo.

## Status

**Deployed and verified on Cloudflare Edge.**
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

`pnpm deploy:preview` exits 2 and deploys nothing when any of
`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` or `FOUNDER_EMAIL` is missing. All three are
currently missing, because only the Cloudflare dashboard can supply the first
two and nobody has entered them.

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
pnpm exec wrangler rollback baf4dbe1-ff1e-4e54-90e7-f326ef38fdd0 --name sadec-flow
pnpm exec wrangler rollback 22d51a8d-4aa8-42fd-a291-a804998ba0b8 --name sadec-flow-pilot
```

**One Cloudflare Dashboard step remains for interactive login on `sadec-flow-pilot`:** the OAuth token in use here has `d1 (write)` and `workers_scripts (write)` but not `access`. The founder needs to attach a Worker-level Cloudflare Access application in the Zero Trust dashboard and set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `FOUNDER_EMAIL` secrets on `sadec-flow-pilot` to allow authenticated browser login on the pilot URL; until then, `sadec-flow-pilot` fails closed (`401`) on all non-public routes as designed.

**No CI runs on this repository.** There is no `.github/workflows/` directory and
`gh api .../actions/runs` reports `total_count: 0`. That matters when reading a
merge: branch protection is also unavailable, because a private repository on a
free plan cannot enable it (`gh api .../branches/main/protection` answers HTTP
403). So nothing on the server re-runs typecheck, the 220 unit tests, the build or
the five browser suites, and nothing stops a push straight to the default branch.
Every green claim in this file was produced by running `pnpm verify` locally and
recording the output; it is not backed by a remote check.
