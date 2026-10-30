# Handover

Written so that somebody with no memory of the previous sessions can pick this
up: how to run it, how to check a claim, what is verified and what is not, and
which decisions still belong to a person rather than to code.

`docs/CHECKPOINT.md` is the status snapshot, `docs/RELEASE.md` records what was
run and what was deployed, `docs/DECISIONS.md` explains why the code looks the
way it does. This file is the entry point to those three.

## Run it locally

```bash
corepack enable && corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
pnpm install --frozen-lockfile

cp .env.example .dev.vars          # template only; no secret in it
pnpm db:migrate:local -- --env demo
pnpm db:seed:demo -- --env demo
pnpm db:migrate:local -- --env test

pnpm verify                        # typecheck → build → unit/integration tests
pnpm test:e2e                      # browser tests, 390px and 1440px
pnpm dev                           # http://localhost:5173
```

`pnpm test:e2e` first runs `scripts/e2e-prepare.ts`: it writes `.dev.vars` and
`.dev.vars.e2e-founder` from `.env.example`, then deletes **only** the demo
database file and re-runs migrations and the demo seed, because the specs book
real units and stock drains across runs (`SADEC_E2E_KEEP_DB=1` keeps the current
database instead). It then starts two dev servers: `:5173` with the
default operator identity and `:5174` with the administrator, because the
founder area is `founder_admin`-only and the default identity deliberately is
not. The founder specs fail if `:5174` is absent or answers as another identity,
rather than passing without running.

**Stop `pnpm dev` first.** The suite owns `:5173` and `:5174`, refuses to reuse a
server it did not start (a reused one can be a process from an older revision),
and `e2e-prepare` refuses to reset the database while either port is busy. It
prints which port is occupied and says the database is untouched. The suite runs
one worker with no retries on purpose — see `docs/DECISIONS.md`.

Identities in the demo seed: `demo-admin` (founder_admin everywhere),
`demo-owner` (owner of `ws-demo-a/b/c`), `demo-operator` (operator in
`ws-demo-a`, `ws-shop-q1`, `ws-shop-damsen`).

## Check a claim instead of believing it

- **A flow works** → run the E2E spec for it; each one asserts on HTTP status,
  request headers and what the screen re-reads from the server, not on the
  presence of a button.
- **The numbers are right** → the arithmetic lives in `src/domain/money.ts`,
  `src/domain/economics.ts`, `src/domain/escrow-ledger.ts`. Screens render what
  the server computed; they never recompute a total.
- **Permission is enforced** → `src/security/authorize.ts` is the only
  chokepoint. A route's action is registered in `ROUTES` in
  `src/worker/index.ts`; a guarded route with no action fails a test.
- **A migration is safe** → `test/sqlite-d1-harness.ts` applies the real files in
  order, so the test path is the upgrade path. Both an empty database and the
  existing demo database are migrated in CI and locally.
- **The public surface leaks nothing** → `test/public-documents.test.ts` inserts
  distinctive private values and asserts none of them appear in any document or
  in the catalog API.
- **The gate is real** → `scripts/verify.ts` fails a run that collects fewer than
  20 tests, and runs `build` before `test` because one test asserts on the
  generated deploy config.

## Current state (2026-10-30, local)

- `pnpm verify`: PASS — 405 tests across 37 files.
- `pnpm test:e2e`: 48 passed (8 spec files × 390px and 1440px), one worker, no
  retries, against the suite's own `.wrangler/e2e-state`; run five times on
  2026-10-30, twice on the release-candidate tree and once from a clone of its
  bundle. The developer's `.wrangler/state` was byte-identical afterwards.
- One flake was found and fixed in the test, not in the product: the
  concurrent-CLI test assumed the losing run always exits 3 or 4, but a run that
  loses the *write* exits 1 ("I cannot tell you whether it landed"). The command
  was right; the assertion is now the invariant that holds under every timing.
  See `docs/CHECKPOINT.md` §"Gates as last run".
- Upgrading a `0005` database to `0006` backfills `restored_from_version_id`
  from the rollback audit row, keeps every other row byte-identical, and the new
  partial unique index refuses a duplicate global version.
- Migrations `0001`–`0007` applied to an empty database; `0007` applied alone to an existing one (the upgrade path).
- Nothing deployed, nothing migrated remotely, no Access change, no external
  message sent — see "Verified vs unverified" below.

## Verified vs unverified

| Claim | Evidence |
| --- | --- |
| Nursery chain: quote → order → deposit → delivery → follow-up | unit + `e2e/nursery-flow.spec.ts` + `test/nursery-transactions.test.ts` (local) |
| Founder chain: discovery → import → proposal → version → rollback → OPC ledger | `test/founder-transactions.test.ts`, `test/founder-discovery.test.ts`, `e2e/founder-flow.spec.ts` (local) |
| B2B chain: lot → booking → deposit → hub → inspection → settlement | `test/b2b-routes.test.ts`, `test/b2b-e2e-workflow.test.ts`, `e2e/b2b-flow.spec.ts` (local) |
| Authorization, tenant boundary, revoked membership | `test/authorize.test.ts`, `test/tenant-boundary.test.ts`, `test/worker-auth.test.ts` (local) |
| Public surface is PII-free and generated | `test/public-documents.test.ts`, `test/aeo-geo-discovery.test.ts` (local) |
| A failed public read is `503`, never an empty catalogue, and is not cached | `test/public-catalog-availability.test.ts` (9 cases: has stock, no stock, query error, missing binding, recovery, not cached, no invented fallback), `test/public-documents.test.ts`, `test/aeo-geo-discovery.test.ts` (local) |
| The bridge distinguishes an empty catalogue from an unavailable one | `test/agent-bridge-contract.test.ts` (8 cases: public API failure, fallback failure, stale cache, stale proposal, workspace switch), `test/agent-bridge.test.ts` (local) |
| The browser suite cannot delete or inherit a developer's database | `test/e2e-harness.test.ts` (12 cases: both servers on `.wrangler/e2e-state`, reset scope, env passed to migrate/seed, path refused outside `.wrangler/`) and a measured 24-file hash compare across a full run (local) |
| The agent bridge reports only server data, and never invents a lot or a revision | `test/agent-bridge.test.ts`, `e2e/agent-proposal.spec.ts` (local) |
| A B2B record answers 404 to a founder who administers neither party | `test/cross-tenant-b2b.test.ts` (local) |
| The browser harness cannot test a stale server or race two specs | `test/e2e-harness.test.ts` (local) |
| The deployed Workers behave as documented | **not verified by this session** — no deploy, no live request |
| Cloudflare Access blocks unauthenticated visitors on the pilot host | **not verified** — needs account access and `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` |
| CI passes on GitHub | **not verified** — `.github/workflows/verify.yml` exists, never ran. Check name (`verify / verify`) is inferred from the file; branch protection was not read or changed (blocker) |
| A fresh pilot database can be opened by its founder | **yes, by a command, locally proved** — `pnpm bootstrap:founder` writes the workspace, identity, membership and audit row as one SQL file; before it runs the same database refuses the founder `403` (kept as the first test). `test/founder-bootstrap.test.ts` (37 tests) plus a local run recorded in `docs/CHECKPOINT.md`. **Not run against a remote database** |
| The file `wrangler d1 execute --file` receives is one transaction, not a list of statements | `test/bootstrap-transport.test.ts` — a file whose last statement violates a CHECK leaves `workspaces/identities/memberships/audit` at `0/0/0/0`; the same file without it writes `1/1/1/1`. `--persist-to .wrangler/transport-*`, real `wrangler` processes, no D1 model (local) |
| Two concurrent CLI runs cannot create two founders | `test/bootstrap-transport.test.ts` — five consecutive runs: at most one success, and the four rows appear as a set (0 or 4) or not at all; a sequential third run always settles at one founder with one provisioning audit row (local). The losing run's exit code varies (1, 3 or 4) with where the processes collide; that is a local-runtime property and is documented, not papered over |
| The bootstrap records who ran it, honestly | `test/founder-bootstrap.test.ts` — the audit detail carries `operator`, `operator_reference: "declared"`, `ticket` and `subject_attestation: "declared-not-verified"`; a 500-character reason with quotes and Vietnamese diacritics round-trips through the SQL file unchanged; a sentinel secret passed as the subject is never echoed (local) |
| `0007` is safe on an existing database with old audit rows | `test/migration-0007.test.ts` — empty database (default `app`, `provisioning` accepted, `'system'` and `''` rejected by CHECK) and a populated `0006` database (old rows become `app`, every other table byte-identical, `PRAGMA foreign_key_check` empty) (local) |
| A backup of a working database can be restored and read back | local drill 2026-10-30: backup → migrate to `0007` → bootstrap → `pnpm db:restore:test` into `sadec_test_restore`, ten tables read back at the backup's values, FK check empty. `docs/CHECKPOINT.md` §"Local release-candidate rehearsal" |
| The bootstrap cannot be reached over HTTP | `test/founder-bootstrap.test.ts` — six bootstrap-shaped paths × two methods, all `404`, and the Worker source imports nothing from the module (local) |
| A second founder, a revoked grant, or a role change cannot be created by the bootstrap | `test/founder-bootstrap.test.ts` — each is a refusal with a named code, and the rows are read back afterwards (local) |
| A deposit can actually be paid | **not possible yet** — no receiving account configured, and no bank integration by design |

## Product decisions still open (blockers, not bugs)

1. **Carrier damage.** `CARRIER` is a domain value with no cost rule. The HTTP
   schema and the `b2b_settlements` CHECK refuse it; who bears a carrier loss is
   undecided.
2. **Partial pilot credit.** A credit larger than the remaining obligation is
   refused (409) because no document defines partial use or carry-forward.
3. **Deposit rate.** One documented assumption of 30% (`DEFAULT_DEPOSIT_RATE_BPS`)
   applies to every workspace. A per-nursery rate needs a parameter.
4. **Order status vs delivery.** Scheduling a delivery does not move the order to
   `scheduled`; a person does. Decide whether that should follow the delivery.
5. **Escrow reality.** The ledger records confirmations; it holds no money. If a
   real escrow account is wanted, that is a new integration and a new scope, not
   a change to this code.
6. ~~**Who may create the first `founder_admin`.**~~ **Decided and implemented**
   in this round: an operator with database access runs `pnpm bootstrap:founder`
   outside HTTP. What remains open is *institutional*, not technical: the pilot
   needs a named person who holds that access, and this repository cannot name
   them. See `docs/PILOT-RUNBOOK.md` §6.
7. **Hub trip driver contact.** `hub_dispatch_trips` exposes `driver_phone` and
   `truck_plate` to any member who can read a trip, which `DECISIONS.md` argues
   for (a shop must be able to call the driver). Whether the phone should be
   visible to every member or only to parties on that trip is still open.

## Next steps in order

1. Someone with Cloudflare access: set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`;
   configure `ESCROW_*` if the pilot takes deposits; run `pnpm db:migrate-pilot`
   (through `0007`); deploy; then run `pnpm bootstrap:founder -- --env pilot`
   (preview first) as the person who holds the database access. Follow
   `docs/PILOT-RUNBOOK.md` — it is the procedure, with stop and recovery
   conditions.
3. Watch `.github/workflows/verify.yml` run once, then make the `verify` check
   required on `main` — using the check name GitHub lists, not the inferred one.
3. Take the five product decisions above, and record each in
   `docs/DECISIONS.md` before changing behaviour.

## Conventions that will bite if ignored

- Relative imports in `scripts/*.ts` (run by Node's type stripping) need the
  `.ts` extension.
- Migrations are append-only. `0006` backfills `restored_from_version_id` from
  audit rows; a repair of duplicate global versions is a human decision, and the
  query to detect it is in that file's header.
- A multi-row write is one `db.batch` whose first statement carries the business
  condition, with later statements gated on a **fresh row id** — never on a
  timestamp. Two requests can share a millisecond; a timestamp gate credited an
  order twice once already.
- The UI's double-click guard is a synchronous `useRef`, not React state: two
  clicks in one event-loop turn both read the same state.
- Money inputs are whole đồng with `step={1}`. A coarser step combined with
  `min` makes valid amounts fail browser validation and the form silently never
  submits.
- The E2E ports belong to the suite. A dev server left running is a startup
  error, not something the suite silently adopts.
- `SAMPLE_LOTS` in `src/domain/aeo-projection.ts` is a fixture for the pure
  document builders. Importing it into runtime code is how the agent bridge came
  to quote inventory that did not exist.
- A `.dev.vars*` file is gitignored for a reason. Do not add a real
  `ACCESS_AUD` to it, to a workflow, or to a fixture.

## Taking over: the bundle, and what was proved from it

`git bundle create sadec-flow-handover.bundle --all` at the tip of this branch,
5.8 MB, `git bundle verify` reports **"records a complete history"**. It carries
`refs/heads/main` = `0f2e0dd` (the branch's base), this working branch, and
`origin/main`.

**The identity of the artefact is in `sadec-flow-handover.manifest.md`, beside the
bundle and not inside it.** The manifest holds the full commit SHA the bundle was
cut from, the branch, the base commit, the bundle's SHA-256 and byte size, the
highest migration, the runtime versions, the test and browser results keyed to
that SHA, and the limits of what was verified. A SHA written into a tracked
document goes stale with the next commit, and a hash written into the artefact it
describes cannot be checked without changing it — which is why the numbers below
describe *method*, and the manifest carries the results.

One thing had to be fixed to make it complete, and it matters for the next
person: **this workspace was a shallow clone.** `git rev-parse
--is-shallow-repository` returned `true` with a graft at `0f2e0dd`, so the first
bundle contained only the branch's own commits and `git clone` of it failed with
`remote did not send all necessary objects`. `git fetch --unshallow origin`
restored the 36 commits of upstream history (read-only; nothing was pushed), and
the bundle was rebuilt. **If a future workspace is shallow, check this before
handing a bundle to anyone** — a bundle cut from a shallow clone looks fine until
someone clones it.

### Proved from a clean checkout

Cloned the bundle to a fresh directory (no `node_modules`, no `.wrangler`, no
`dist`, no `.dev.vars*` — `git ls-files` shows none of them; only `.env.example`
matches `^\.env`), then:

| Step | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK (pnpm 12.14.0, same `packageManager`) |
| `pnpm verify` | **PASS — 405 tests / 37 files** |
| `pnpm test:e2e` | **48 passed (1.7 m)** — the clone created its own `.dev.vars` and `.dev.vars.e2e-founder` from `.env.example`, so the run needed nothing from this workspace |
| `pnpm db:migrate:local -- --env test` then `pnpm bootstrap:founder -- --env test … --apply --subject-verified` | **CREATED** — migrations `0001`–`0007` from empty, then one workspace, identity, membership and provisioning audit row, with no secret or state file copied from the old workspace |
| Processes after both runs | none left; `pgrep -f vite\|wrangler` empty |
| Clone's working tree after the runs | clean (`git status` empty; the identity files are ignored) |

The clone's E2E ran with Chromium from `/tmp/chromium` (`@sparticuz/chromium`),
because Playwright's browser CDN is unreachable from this sandbox. **That is a
substitute, not the browser CI uses**, so these results say the suite is
reproducible and self-preparing — not that CI's Chromium will pass. The same
substitute ran every browser run recorded in this repository.

Both runs print, per Worker start, `Unable to fetch the Request.cf object!` and one
TLS disconnect stack trace: Miniflare asking an external endpoint for geolocation
data it cannot reach here, then falling back to a placeholder. It is a sandbox
network artefact, it appears in every run including the ones in the working
repository, and no test depends on it. It is recorded so a future reader does not
mistake it for a failure.

### Diff from the base, grouped by purpose

`git diff --shortstat 0f2e0dd..HEAD` → **91 files, +16,107 / −3,782** at this
handover.

| Group | Files | + | − | What moved |
| --- | --- | --- | --- | --- |
| Tests | 23 | 4,662 | 471 | Concurrency and transport proof, tenant boundary, catalog availability, bridge contract, harness rules, `0007` migration, restore read-back |
| Ops / routes | 11 | 3,349 | 882 | Core handlers; the `503` catalogue contract lives here |
| UI | 11 | 2,602 | 692 | Screens, agent bridge, notice states |
| Docs / CI | 7 | 1,887 | 47 | This file, CHECKPOINT, DECISIONS, RELEASE, PRODUCT, runbook, gates, workflow |
| Founder domain | 2 | 1,227 | 544 | Discovery, configuration versions, the bootstrap policy |
| Scripts | 11 | 875 | 60 | Migration, seed, backup, restore, bootstrap, deploy guards |
| Browser suite | 4 | 736 | 10 | Specs and the preparation script |
| Migrations | 4 | 201 | 3 | `0005`, `0006`, `0007`, and the demo seed |
| Worker / security | 3 | 189 | 9 | Entry, session resolution, authorization |
| Domain | 3 | 134 | 23 | Projections, AEO rendering |
| Config | 5 | 149 | 22 | `wrangler.jsonc`, vite, playwright, tsconfig, package scripts, `.env.example` |
| Public assets / other | 7 | 96 | 1,019 | Hand-written pages replaced by generated ones; one planning note |

Net −3,782 with +16,107 is not churn: the deleted public assets were static copies
of content now generated from the database, and most additions are tests and the
screens that make them meaningful.
