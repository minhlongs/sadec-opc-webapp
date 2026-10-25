# Release

What was actually run, and what it produced. A command is listed here only after
it ran on this machine; nothing below is aspirational. §17's rule: never put a
command in the README before it exists and matches the repo.

## Status

**Nothing is deployed.** No Worker, no pilot URL, no remote startup migration
applied. This file records the local state and the exact commands that remain.

## Environment

| Item | Value |
| --- | --- |
| Package manager | pnpm 12 (lockfile committed) |
| Node | see `engines` in `package.json` |
| Compat date | `2026-10-08` in `wrangler.jsonc` |
| Branch | `feat/sadec-flow-part-a` |
| Remote | `https://github.com/minhlongs/sadec-opc-webapp.git` (private) |

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
| `pnpm test` | PASS — 147 tests across 11 files |
| `pnpm build` | PASS — exit 0 |
| `pnpm test:e2e` | PASS — 6 tests (3 specs × 390px and 1440px) |
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

## Missing gates — not yet verified

§15 case 17 asks for evidence that cuts are visible to a stranger on the real
URL: an unauthenticated request is refused, a forged identity header is
refused, and no dev identity path exists on a deployment. **None of these has
run, because nothing is deployed.**

When the URL exists, run against it and record the real output here:

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<pilot-url>/api/health
curl -sS -o /dev/null -w '%{http_code}\n' https://<pilot-url>/api/orders
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Cf-Access-Jwt-Assertion: not-a-token' https://<pilot-url>/api/orders
```

Expected: health returns 200 without a token, and the other two return 401 or a
redirect to the Access login. The point of the third command is that a forged
header is refused *by signature*, not by its presence — a header that merely
exists must not be enough.

**One gap this session cannot close:** the GitHub token in use here has `d1
(write)` but not `access`. Migrations can be applied, but the Access application
that issues the tokens cannot be created or inspected from here. Whoever holds
account access needs to create the Worker-level Access application, add the
founder's email to its allowlist, and confirm the returned audience tag matches
what was deployed.

**No CI runs on this repository.** There is no `.github/workflows/` directory and
`gh api .../actions/runs` reports `total_count: 0`. That matters when reading a
merge: branch protection is also unavailable, because a private repository on a
free plan cannot enable it (`gh api .../branches/main/protection` answers HTTP
403). So nothing on the server re-runs typecheck, the 147 unit tests, the build or
the three browser suites, and nothing stops a push straight to the default branch.
Every green claim in this file was produced by running `pnpm verify` locally and
recording the output; it is not backed by a remote check.
