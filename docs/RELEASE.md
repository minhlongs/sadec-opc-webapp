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

Three D1 bindings are declared in `wrangler.jsonc`: `sadec-demo`, `sadec-test`,
`sadec-test-restore`. They are separate by design — §3 requires demo, test and
pilot data never to mix, so a test that writes cannot reach the demo database a
customer is looking at.

## Commands run locally, with results

| Command | Result |
| --- | --- |
| `pnpm install` | PASS, after `pnpm approve-builds esbuild workerd` |
| `pnpm typecheck` | PASS — 0 errors |
| `pnpm test` | PASS — 84 tests across 6 files |
| `pnpm build` | PASS — exit 0 |
| `pnpm test:e2e` | PASS — 2 tests at 390px and 1440px |
| `pnpm db:migrate:local` | PASS |
| `pnpm db:seed:demo` | PASS — idempotent, safe to re-run |
| `pnpm db:backup` | PASS |
| `pnpm db:restore:test` | PASS — restores into `sadec-test-restore` |

`db:restore:test` writes only to `sadec-test-restore`, and the script drops that
database's tables before replaying. No path in any script writes to
`sadec-demo` or the pilot database. `deploy:preview` is the only command that
touches the network, and it refuses to run until the Access configuration is
present.

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
