# Sa Đéc Flow

A web app for running a plant nursery's quoting and operations, plus the
founder's own discovery and configuration work. Built for a single real use —
founder self-demo at the nursery on localhost, a nursery owner self-trial on a
private URL, an investor demo of the founder area — with no public launch and no
purchased domain.

Private preview only. Every route sits behind Cloudflare Access. See
`docs/RELEASE.md` for what is deployed (currently: nothing) and
`docs/CHECKPOINT.md` for what works today.

## What this is right now

Foundation, not a finished product. The build pipeline, the money arithmetic,
the authorization chokepoint and the Access token verifier exist and are tested.
**No screen is built.** `src/main.ts` writes one string into the page. Not one
flow — catalog, inquiry, quote, order, deposit, delivery or follow-up — is
reachable in a browser yet.

If you are evaluating this repo, that is the honest state. Phase 1 (one
vertical slice, running in a browser) is next, and `docs/CHECKPOINT.md` says so.

## Stack

React 19 + TypeScript + Vite, a Hono API on Cloudflare Workers, D1 for data,
Zod for validation, pnpm. Money is VND stored as an integer — never a float, and
never rounded in an intermediate step.

## Setup

Node 22 (the `@types/node` and `jose` versions here assume it), and pnpm 12.

```bash
pnpm install
```

pnpm 12 does not read the `pnpm` field in `package.json`, so the build-script
allowlist lives in `pnpm-workspace.yaml`, which is deliberately tracked. Without
it, `esbuild` and `workerd` cannot run their postinstall scripts and the build
fails for no visible reason.

### Local configuration

```bash
cp .env.example .dev.vars
```

`.dev.vars` is gitignored. All three values originate in `.env.example`, and
`ACCESS_AUD` in particular must be kept out of the repo — a leaked audience tag
is what makes a forged Access token look valid.

For local work, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` can be left empty. A local
API route then refuses every request rather than assuming an identity — the local
identity adapter that substitutes a development identity arrives with phase 1.

## Commands

| Command | Does |
| --- | --- |
| `pnpm dev` | Local dev server |
| `pnpm build` | Production build |
| `pnpm typecheck` | `tsc --noEmit` — 0 errors expected |
| `pnpm test` | Unit tests, via Vitest |
| `pnpm test:e2e` | Browser tests at 390px and 1440px, via Playwright |
| `pnpm verify` | All three of typecheck, test and build |
| `pnpm db:migrate:local` | Apply migrations to the local D1 |
| `pnpm db:seed:demo` | Load demo data (idempotent, re-runnable) |
| `pnpm db:backup` | Export the local database |
| `pnpm db:restore:test` | Restore a backup into `sadec-test-restore` |
| `pnpm deploy:preview` | Deploy the pilot Worker |

### Environment guard

Every script that touches a database resolves its environment through
`scripts/require-environment.ts`. That module holds a map of command → permitted
environments; **a command missing from the map is permitted nothing.** Local and
demo databases are not reachable by a command bound to pilot, and the group
refuses to run when the current environment does not match what the command
allows.

The guard does not infer. If a command's key does not match its script name, the
command accepts nothing, and a test asserts that.

### Databases

Three D1 bindings are declared in `wrangler.jsonc`: `sadec-demo`, `sadec-test`,
`sadec-test-restore`. They exist so §3's separation holds — demo data a customer
is looking at can never be written by a test, and no restore can land on the
demo database. `db:restore:test` has no path that overwrites a real database.

## Modes

`APP_ENV` in `.dev.vars` names the mode: `local`, `test`, `demo`, `pilot`. It
controls the environment guard. The dev identity adapter and the persistent
`DEMO` banner arrive with phase 1; when they do, the banner is global state read
from one place, not a copy pasted into each page, because synthetic data must
never appear without it.

## Security model in one paragraph

The Access token in `Cf-Access-Jwt-Assertion` is verified by the Worker itself
against the team domain's published keys, checking `iss`, `aud` and `exp`. This
is required because a Worker serving Static Assets runs behind an internal router
Worker which does not forward `ctx.access`, so waiting on that object would
refuse the founder on a deployment while passing locally. Authorization then
runs through a single chokepoint in `src/security/authorize.ts`; no route
answers "may this identity do this" by any other path. Everything unreadable
fails closed — no store, no Access configuration, a revoked membership, or an
action nobody declared all produce a refusal, never an invented identity.

## What is verified and what is not

Verified by running: typecheck at 0 errors, 84 unit tests across 6 files, a
production build at exit 0, and 2 browser tests rendering at both breakpoints.

**Not verified:** anything on a real URL. Nothing is deployed, so §15 case 17
(an unauthenticated request is refused, a forged header is refused, no dev
identity path exists) has never run. Also not verified: the Access application
itself — the GitHub token in use here has `d1 (write)` but not `access`, so this
repository can create databases and apply migrations but cannot create or
inspect the Access application. The steps are recorded in `docs/RELEASE.md`.

## Documentation

- `README.md` — this file
- `docs/PRODUCT.md` — what ships, the three roles, and the business rules
- `docs/DISCOVERY.md` — how to interview, import, and classify evidence
- `docs/RELEASE.md` — commands run, environments, URLs, missing gates
- `docs/DECISIONS.md` — the choices that change how the code is read
- `docs/CHECKPOINT.md` — current state, next steps, and how to reproduce a
  problem
- `examples/` — a demo import fixture and a template CSV
- `plans/261024-0154-sadec-flow-part-a/` — the plan, its phases and its
  red-team outcome

## Known limits

- A build is not a launch. Nothing here claims "production-ready" because it
  exists and compiles.
- No domain is purchased, so `workers.dev` is the only production hostname.
- Phase 0's guards are tested against real key pairs and a real JWKS endpoint,
  but the success path needs a live Access token to be exercised end to end.
- Reports written during work live under `plans/*/reports/` and are gitignored,
  because they can contain real data collected while working. The plan and phase
  files themselves are tracked so the next session can read them.
