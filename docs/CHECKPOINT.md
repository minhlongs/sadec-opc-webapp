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

**Both Demo and Pilot Workers were deployed on Cloudflare Edge at the time recorded in `docs/RELEASE.md` (remote schemas at `0004`). This session did not re-deploy and did not verify the live URLs; treat the deployment state as recorded-by-release-notes, not as re-proven.**
- Demo Worker: `https://sadec-flow.agencyos-openclaw.workers.dev` (Version `33aae98b-ffc2-44d8-9e81-56e3bed70732`, remote D1 `sadec-demo` migrated through `0004` and seeded).
- Pilot Worker: `https://sadec-flow-pilot.agencyos-openclaw.workers.dev` (Version `0ab79a63-3e82-434d-b0f0-c40702ed29b2`, remote D1 `sadec-pilot` migrated through `0004`, starts empty with 0 rows in `customers`, `orders`, `founder_interviews`, `receipts`, and fails closed with HTTP `401` on unauthenticated, forged-JWT, and `X-Dev-Identity` requests). Read `docs/RELEASE.md`.

## Deployment moves to GitHub Actions (2026-10-31, prepared, not run)

The owner's decision this round: stop trying to deploy from the assistant's
sandbox. Arena is for code, tests, the pull request and CI; **GitHub Actions is the
deployment executor**, and the owner enters the credentials on GitHub. The reason
is recorded above — no Cloudflare credential in the sandbox, and Cloudflare
unreachable from it at the transport layer while GitHub answered normally.

**Nothing in this section has been run.** No workflow has ever been dispatched, no
GitHub Environment exists (`gh api …/environments` returns `total_count: 0`), no
deploy, migration or backup has happened, and `DEMO_LIVE_VERIFIED` /
`PILOT_LIVE_VERIFIED` remain **no**. What exists is preparation, with the checks
below proving it locally.

### What is now in the tree

| Path | What it is |
| --- | --- |
| `.github/workflows/deploy-pilot.yml` | build + upload, `workflow_dispatch` only |
| `.github/workflows/db-backup-pilot.yml` | export, then replay it, in one job |
| `.github/workflows/db-migrate-pilot.yml` | ledger conflict check → migrate → read back |
| `.github/workflows/ops-preflight-pilot.yml` | account / database / Worker / Access checks |
| `.github/workflows/smoke-pilot.yml` | readiness + fail-closed evidence, holds no secret |
| `.github/workflows/bootstrap-founder-pilot.yml` | the one-time founder grant |
| `scripts/deploy-ref.ts` + `scripts/require-main-sha.ts` | the "only a proved commit on `main`" rule |
| `scripts/preflight-facts.ts` + `scripts/cf-preflight.ts` | the target checks, read-only |
| `scripts/migration-ledger.ts` + `scripts/db-migration-drift.ts` | applied-versus-tree comparison |
| `scripts/db-restore-drill.ts` + `scripts/restore-sql.ts` | the replay drill and its shared SQL helpers |
| `test/workflows.test.ts` and three others | hygiene, the ref rule, the preflight, the ledger |
| `docs/DEPLOY-VIA-GITHUB.md` | the owner's configuration checklist |

Each workflow is dispatch-only, declares `environment: pilot`, uses a
`concurrency` group that serialises pilot work with `cancel-in-progress: false`,
pins every action to a commit SHA, asks for `contents: read` and `actions: read`
only, and re-checks the commit before checking it out. `test/workflows.test.ts`
fails on a regression in any of those.

### The smoke gate, fixed

`pnpm smoke:live` no longer treats a well-formed `503` as a pass. Readiness and
fail-closed are separate phases: a catalogue or discovery page that cannot reach
the database **fails readiness**, and the correct `503` handling is recorded
separately as a note. `--expect-env` is required and must match what the Worker
reports, the target must be the right kind of host for that environment, a forged
`Cf-Access-Jwt-Assertion` must be refused, and the missing-token, dev-identity and
PII checks are unchanged. A positive login and a save/reload are still a **human**
gate: 12 tests cover the refusals, and none of them is evidence of a successful
sign-in.

### The restore drill, proven

On a throwaway local database seeded from `0001`–`0007` plus the release fixture,
`wrangler d1 export` produced a 33,280-byte pilot-named export; `pnpm db:restore:drill
-- --env pilot --file <that file>` replayed **32 tables** and read back
`workspaces 2, identities 2, memberships 2, quote_revisions 1, orders 1, receipts 1,
receipt_events 1, escrow_ledger_entries 1, config_versions 2, audit_events 3`, with
`PRAGMA foreign_key_check` clean and `integrity_check ok`. The scratch database was
deleted afterwards. The drill has **no default file**: a missing `--file`, a
`.replay.`/`.drill.` file, or a filename that does not start with the binding name
is a usage error.

### Gates as last run (this round, locally)

| Gate | Result |
| --- | --- |
| `pnpm verify` | **PASS — 532 tests across 42 files** (was 414/38; the increase is the new guards, no test was removed or skipped) |
| `pnpm typecheck` | clean |
| CI (first push of PR #27) | **failed in 7 s** — `Unable to resolve action actions/setup-node@39370e39…`. A wrong pinned SHA, not a test result: the workflow never started. Corrected to the SHAs read back from the API (`checkout` `11d5960a`, `setup-node` `49933ea5`, `upload-artifact` `ea165f8d`), and recorded in `docs/DEPLOY-VIA-GITHUB.md` §6 as the reason to verify a SHA exists before pinning it. |
| CI on the corrected commit | run [41202309032](https://github.com/minhlongs/sadec-opc-webapp/actions/runs/41202309032), `verify`, **success** in 2 m 51 s — all nine executed steps green including the browser suite at 390px and 1440px; the evidence upload is skipped by design |
| CI warning, recorded not dismissed | GitHub annotates the run: `actions/checkout` and `actions/setup-node` at their `v4` SHAs target Node 20 and are forced onto Node 24. They work; the deprecation is real, and re-pinning to `v5` is a follow-up that needs each new SHA verified first (see `docs/DEPLOY-VIA-GITHUB.md` §6) |

### What the owner must do before any of it can run

Create the `pilot` GitHub Environment **first** (a workflow that names an
environment GitHub has never seen creates it without protection rules), add
`CLOUDFLARE_API_TOKEN`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as its secrets and
`CLOUDFLARE_ACCOUNT_ID` as its variable, and set the two Access values as Worker
secrets. `docs/DEPLOY-VIA-GITHUB.md` lists the steps, the scopes per operation and
how to read a failure.

**Unverified, and stated rather than assumed:** whether required-reviewer approval
is available on this account's plan. The repository has no environment at all
today, so the approval control has never been exercised here.

**Demo is not deployable from GitHub, deliberately.** There is no `deploy:demo`
command, no guarded remote-migration path for the demo database and no demo Access
configuration. A workflow that invented one would be a new unguarded write path.

## Shipped on 2026-10-31, deployed nowhere

The tree that PR #21 carried is now on `main`. It could not be merged directly —
`main` had moved on by one docs commit (#22, the payOS dossier) — so the verified
branch was merged onto current `main` and shipped as PR #23 rather than rebased.
PR #21 is closed as superseded, with a comment pointing at the merge commit.

| Item | Value |
| --- | --- |
| `main` after the merge | `681b84114c69f41274988d384d4fba232a824e05` (squash of PR #23 `--squash`) |
| Merge commit inside the branch | `755f52d3603deb914585672b517f1767c138040c` (`--no-ff`, no conflicts) |
| CI on that merge commit | run [41194797263](https://github.com/minhlongs/sadec-opc-webapp/actions/runs/41194797263), `verify`, **success**, browser suite included |
| CI on the pull request | run [41195035444](https://github.com/minhlongs/sadec-opc-webapp/actions/runs/41195035444), `verify`, **pass** (2 m 29 s) |
| `pnpm verify` locally on the merged tree | PASS — 405 tests across 37 files |

**No Worker, remote database or Access setting was touched by this session**, and
the live URLs were not reachable from it (see "Blocked"). The deployed versions
recorded above are unchanged: still the `0004`-era deployment, still not
re-verified. `CODE_SHIPPED` holds; `DEMO_LIVE_VERIFIED` and
`PILOT_LIVE_VERIFIED` do not.

The local recovery drill was repeated on the merged tree, in an isolated copy
(`git archive` into `/tmp/drill`, its own `.wrangler/`): `0001`–`0007` applied
from empty; `scripts/fixtures/release-drill-dataset.sql` loaded (2 workspaces,
2 identities, 1 order, 1 receipt, 1 escrow row, 2 config versions, 3 audit rows);
`db:backup` wrote a 33 KB export; `bootstrap:founder` refused a workspace-name
mismatch (exit 3) and previewed without writing; `--apply --subject-verified`
added exactly one identity, one membership and one `provisioning` audit row;
`db:restore:test` restored into `sadec_test_restore` and read back
`2/2/2/1/1/1/1/1/2/3` — the pre-bootstrap moment, which is what a restore is for.
`wrangler deploy --env pilot --dry-run` resolved `sadec_pilot` from the config the
build generates; nothing was uploaded.

## Gates as last run

Local, on a fresh sandbox (2026-10-30, Node v22.22.3, pnpm 12.14.0, Chromium 153
as a substitute for Playwright's bundled browser — see "Blocked"):

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS — 0 errors |
| `pnpm build` | PASS — exit 0 |
| `pnpm test` | PASS — 405 tests across 37 files |
| `pnpm verify` | PASS — typecheck → build → test, with the counts above |
| `pnpm test:e2e` | PASS — 48 tests: 8 spec files × 390px and 1440px, one worker, no retries, against the suite's own `.wrangler/e2e-state`; run five times on 2026-10-30, twice on the release-candidate tree and once from a clone of its bundle |
| Migration path | PASS — `0001`–`0007` on an empty database, `0007` over a populated `0006` database, and the same upgrade inside the local drill below |

The 2026-10-31 session re-ran the first four rows on the merged tree and got the
same result (`verify` → 405 tests across 37 files). It did **not** re-run the
browser suite locally: `cdn.playwright.dev` is unreachable from that sandbox, so
`playwright install chromium` fails, and the 48-test row above is still the
2026-10-30 measurement. The browser suite did run on GitHub for this release —
twice, in the two runs named in "Shipped on 2026-10-31" — which is a real
Chromium on `ubuntu-latest`, not a substitute binary.

The 390 → 405 growth is explained, not assumed: +5 in
`test/founder-bootstrap.test.ts` (operator, ticket, missing-operator refusal,
secret non-echo, quotes/Unicode/long-reason round-trip), +4 in
`test/bootstrap-transport.test.ts`, +3 in `test/migration-0007.test.ts`, +3 in
`test/db-restore-readback.test.ts`.

The counts are read from the run, not carried over: an earlier revision of this
file reported 220 / 22 files and 24 browser tests, which described the tree at
that time and is now history. `scripts/verify.ts` fails a test run that collects
fewer than 20 tests, so a collection error cannot look like a pass, and it runs
`build` before `test` because one test asserts on the deploy config the build
generates (with the old order a clean clone failed its first `verify` and passed
every run after it).

The browser suite drives two dev servers: `:5173` with the default (operator)
demo identity, and `:5174` with `DEV_IDENTITY_SUBJECT=demo-admin`, which the
founder area requires. `playwright.config.ts` starts both; the founder specs
**fail** if the second one is absent or answers as a different identity rather
than skipping, because a skipped test that looks green is the failure mode this
suite exists to avoid. It also starts from the seed: `pnpm test:e2e` runs
`scripts/e2e-prepare.ts`, which deletes only the **demo** database file (the one
holding `ws-demo-a`), then migrates and seeds it, because the specs book real
units and stock otherwise drains across runs. `SADEC_E2E_KEEP_DB=1` keeps the
current database for someone who wants to.

Two corrections came out of the audit, both recorded in `docs/DECISIONS.md`:

- The suite now runs **one worker, no retries, and never reuses a server**. A
  reused server can be a process from an older revision, which is how a previous
  session reported a green run for code that was not in the tree; parallel
  workers could book the same seeded lot and fail on each other's write. The
  prepare script refuses to delete anything while `:5173` or `:5174` is
  occupied, and says so.
- **`SQLITE_BUSY` has no proven root cause.** Status: *not reproduced in a probe
  of 40 concurrent writes* (split across both dev servers: 40 × `201`, no lock
  error), so the earlier claim that "resetting the demo database fixed the lock
  errors" is withdrawn rather than restated — a reset cannot affect write
  contention, and no trace was ever captured. What was actually addressed is the
  two mechanisms that make the suite non-deterministic and that a reset cannot
  touch: a **stale or duplicated dev server** (now impossible to adopt, because
  `reuseExistingServer` is false and the ports are checked before anything is
  deleted) and **fixture sharing** (one worker, and the suite now runs on its own
  database directory instead of the developer's). The reset remains, for what it
  really does: give each run a known starting *stock* level. If a lock error
  appears again, capture it — the server log, the failing spec, and the `.sqlite-wal`
  size at the time — and treat that as the first evidence, not as a recurrence of
  a known bug.

One flake, its cause, and why the fix was in the test: an early run of the
concurrent-CLI test failed on `expect([0, 3, 4]).toContain(1)` — one of the two
racing processes exited **1**, the "the write itself failed and I cannot tell you
whether it landed" code. Four consecutive full-suite runs then produced 3 passes
and 1 failure, so the outcome is real and rare, not a one-off. The command was
right to report that code; the test's model of the race was wrong, because it
assumed the loser always loses in a way that is provably empty. It now asserts
what must hold under every timing — at most one success, and the four rows a
bootstrap writes appear as a set (0 or 4, never a partial one) — and it passed
five consecutive times afterwards.

What the gates do not cover, stated so a green run is not read as more than it
is: nothing here is a CI run, because the workflow in
`.github/workflows/verify.yml` has not executed on GitHub yet, and nothing here
touches a deployed Worker or a remote database.

## Audit of the handed-off tree (2026-10-30)

The seven commits the previous session reported (`3a37425`, `4121fb1`,
`90b6b6d`, `77658bd`, `e8208da`, `aa0183b`, `21b2c06`) **do not exist in this
checkout**: the reflog held only the clone and the branch checkout, and `HEAD`
was the base commit `0f2e0dd`. Uncommitted working-tree changes were present
(53 files modified, 20 untracked) and were committed as `d02ae83` before anything
was edited, so this file describes a reproducible `HEAD` rather than a tree
somebody happened to have open.

**What that does and does not establish.** It preserves a *snapshot of the
working tree as it was handed over*. It does **not** establish that the snapshot
is equivalent to the seven commits named in the handover: those objects do not
exist here, so their boundaries, messages, intermediate states and authorship
cannot be checked, and a difference between them and the snapshot would be
invisible. The snapshot is the artefact; the commit list is unverifiable
testimony. Everything verified in this file was verified against the snapshot.

What the audit proved, fixed, and left alone. "Proved" means an assertion that
fails if the behaviour changes, not a reading of the code.

| Area | Verdict | Evidence |
| --- | --- | --- |
| Authorization, roles, revoked membership, workspace switch | **Proved, unchanged** | `test/authorize.test.ts`, `test/tenant-boundary.test.ts`, `test/cross-tenant-b2b.test.ts` (new), `e2e/b2b-flow.spec.ts`. Every route resolves through `src/security/authorize.ts`; unauthenticated → 401, wrong role/workspace → 403, foreign record → 404 |
| Money: receipts, over-collection, reversal, concurrent confirms | **Proved, unchanged** | `test/nursery-transactions.test.ts`; re-proved through HTTP: operator confirms → 403, over-collection → 409 naming the remaining amount, two concurrent confirms → exactly one 200, reversal keeps `create/confirm/reverse` events and debits `collected_vnd` |
| OPC ledger, credits, over-allocation | **Proved, unchanged** | `test/founder-transactions.test.ts`; seeded ledger reads 10,000,000 collected / 3,000,000 outstanding, matching the documents |
| Import preview/apply, config versions, rollback lineage | **Proved, unchanged** | `test/founder-transactions.test.ts` (25), including "a failed batch writes nothing" and the `0006` backfill |
| Booking stock, deposit, Hub, inspection, settlement | **Proved, unchanged** | Concurrent full-stock bookings → one `201`, one `409`, stock exactly 0; deposit confirm twice → one ledger row; a second settlement release → `409`, no second ledger set |
| VietQR / escrow account | **Proved, unchanged** | No default account anywhere in `src/`, `migrations/` or `public/`; with `ESCROW_*` unset no QR is built |
| Public documents | **Fixed twice; the first fix was not enough** | They answered a failed read with `max-age=60`, caching "no lots" as fact. `no-store` alone still called a failure a success; now a failed or unbound read is `503` + `code: catalog_unavailable` + `retry-after`, while a healthy read with no published lots stays `200` + `lots: []`. `/llms.txt`, `/robots.txt`, `/sitemap.xml`, `/api/schema` stay `200` because they read no inventory (`test/public-catalog-availability.test.ts`, `test/public-documents.test.ts`, `test/aeo-geo-discovery.test.ts`) |
| Agent bridge | **Two bugs fixed** | `listSupplyLots`/`findCachedLot` seeded `SAMPLE_LOTS` when the cache was empty, handing an agent four lots with real ids and invented availability; now the bridge reports only what the server reported. And every failure collapsed into `[]`, so a dead service looked like an empty catalogue — the bridge now returns `OK`/`STALE`/`UNAVAILABLE`, a stale list may be shown but never used to propose, and `nursery_workspace_id` is gone from the public DTO instead of being faked as `''` (`test/agent-bridge.test.ts`, `test/agent-bridge-contract.test.ts`) |
| Browser harness | **Three fixes** | Stale-server reuse and parallel workers; now one worker, no retries, never reuse, and a port guard before the database is deleted. Third: the suite ran against the developer's D1 directory, so it could reset a working database or inherit its drift — it now owns `.wrangler/e2e-state`, and the port guard still runs before anything is deleted (`test/e2e-harness.test.ts`) |
| Migrations | **Proved independently** | All six applied to an empty database (32 tables); `0006` applied to a `0005` database backfilled `restored_from_version_id` from the rollback audit row, left every audit row and parameters byte-identical, and the new partial index refused a duplicate *global* version; `pnpm db:migrate:local -- --env test` applied `0001`–`0006` through the real CLI |
| CI workflow | **Added and reviewed, not run** | Content asserted by `test/deploy-config.test.ts`; no GitHub run exists, so "CI passes" is not claimed, and the status-check name GitHub creates (`verify / verify`) is inferred from the file — a blocker until a run is observed. |
| Pilot entry | **Fixed — provisioning command** | An empty database still refuses everyone (kept as the first test), and `pnpm bootstrap:founder` now creates the workspace, identity, membership and one audit row in a single transaction, outside HTTP. Re-runs report `ALREADY`; revoked, wrong-role, second-founder and name-conflict cases are refusals, not repairs. `test/founder-bootstrap.test.ts` (32 tests) |
| Deploy contract | **Corrected** | `deploy:preview` no longer requires `FOUNDER_EMAIL`/`FOUNDER_SUB`: nothing read them, and access comes from the bootstrap command. Deploy asks only for `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, which the Worker verifies against (`scripts/deploy-requirements.ts`) |
| Carrier-fault cost, partial credit, deposit rate, order-vs-delivery | **Left as decisions** | `CARRIER` is refused by the HTTP schema *and* the `b2b_settlements` CHECK, and the inspection screen says carrier damage has no approved cost rule and belongs in the note field |

## Next

1. **The owner configures GitHub, then a separate execution task runs the
   workflows.** In order: create the `pilot` environment and its secrets
   (`docs/DEPLOY-VIA-GITHUB.md` step 1), dispatch `ops-preflight-pilot`, then
   `db-backup-pilot`, `db-migrate-pilot`, `deploy-pilot`, `smoke-pilot`, and
   finally `bootstrap-founder-pilot` once a verified Access subject exists. Each
   takes the full SHA of a commit on `main` with a green `verify` run. Configure
   the escrow account separately if the pilot will take deposits — no workflow
   touches it. Deploying grants nobody anything; the bootstrap workflow is the step
   that does, and it is run once and by hand. **`docs/PILOT-GATES.md` is the sheet
   to fill in**: nine gates, each with the evidence that exists and a status that
   currently reads `not performed` for every remote one, plus the permissions the
   operator needs and the stop conditions.
1a. Do **not** dispatch any of them from the assistant's sandbox: Cloudflare is
   unreachable from it, and the credentials belong on GitHub. The preparation is
   finished; the execution is a hand-off.
2. Enable branch protection on `main` requiring the `verify` check, once a run
   of `.github/workflows/verify.yml` has been observed to pass.
3. Product decisions outstanding: carrier-fault cost, partial pilot-credit use,
   whether order status should follow delivery scheduling, and a per-workspace
   deposit rate (currently one documented 30% assumption).

## Provisioning the first founder (2026-10-30, local)

The blocker recorded in the previous round is resolved by a command, not by a
route. `pnpm bootstrap:founder -- --env <test|pilot>` previews by default and
writes only with `--apply --subject-verified`.

What was actually run, in order, against the local `.wrangler/state` database
(`sadec_test`) through the same `wrangler d1 execute` transport the pilot would
use:

| Step | Command | Observed |
| --- | --- | --- |
| Upgrade the schema | `pnpm db:migrate:local -- --env test` | `0007_audit_provisioning_actor.sql` applied alone to the existing database — the upgrade path, not a fresh build |
| Before any bootstrap | `SELECT COUNT(*)` on the four tables | `0 / 0 / 0 / 0` |
| Preview | `pnpm bootstrap:founder -- --env test …` | "would be created" for all four rows, and counts still `0` afterwards |
| Apply | same with `--operator` (required) and `--apply --subject-verified` | `CREATED`: workspace `ws-pilot`, identity, membership `founder_admin`, audit `actor_source=provisioning`, `actor_id` NULL, `granted_by` NULL |
| Read back | joined `SELECT` | one row matching the input, detail JSON carrying the operator's reason |
| Re-run | same apply | `ALREADY`, nothing written, audit still 1 row |
| Second founder | different subject, another workspace | refused `founder_exists`, exit 3 |
| `--env demo` | any input | refused by the guard before any database call, exit 2 |
| Revocation statement | the SQL in the runbook, against an isolated `.wrangler/revoke-probe` database | membership kept with `revoked_at` set, audit grew to 2 rows, re-running the file changed nothing, and a later bootstrap was refused `membership_revoked` |

The same command was then run from a **clean clone of the handover bundle** — no
`node_modules`, no `.wrangler`, no `.dev.vars*` copied from this workspace — where
`pnpm db:migrate:local -- --env test` applied `0001`–`0007` from empty and
`--apply --subject-verified` created one workspace, identity, membership and
provisioning audit row. That is the takeover path: nothing about provisioning
depends on a file left behind in the old workspace.

The authorization half is proved separately, in `test/founder-bootstrap.test.ts`,
through the real Worker `fetch`: the founder's subject gets `200` and
`role: founder_admin` in the granted workspace and `403` in any other; a second
identity with the **same email** gets `403`; a revoked founder is refused on the
next request; two concurrent applies produce one founder.

## Handover artefact

`sadec-flow-handover.bundle` (`git bundle create … --all`, 5.8 MB) carries the
full history: `main` = `0f2e0dd`, this branch, `origin/main`. `git bundle verify`
reports a complete history and a trial clone of it produced the results in
`docs/HANDOVER.md` §"Taking over".

Its identity lives in `sadec-flow-handover.manifest.md`, **beside** the bundle and
never inside it: full commit SHA, SHA-256 and byte size of the bundle, base
commit, highest migration, runtime versions, and the gate results keyed to the
commit they were run on. A SHA written into a tracked document goes stale the
moment a commit is added, and a hash written into the artefact it describes
cannot be checked without changing it. Read the manifest, not this paragraph,
for the release-candidate identity.

**A bundle cut from a shallow clone is incomplete and looks fine.** This
workspace was shallow (graft at `0f2e0dd`); the first bundle cloned with `remote
did not send all necessary objects`. `git fetch --unshallow origin` fixed it.
Check `git rev-parse --is-shallow-repository` before handing a bundle over.

## Local release-candidate rehearsal (2026-10-30)

An isolated clone (`/tmp/drill-src`: no `.git`, no `node_modules`, its own
`.wrangler/`) was taken through the whole recovery story on `sadec_test`, with
`0001`–`0006` applied and a purpose-written dataset — not demo seed, not pilot
data — loaded from `scripts/fixtures/release-drill-dataset.sql`: two workspaces,
memberships, an accepted quote revision, an order, a confirmed receipt and its
event, a held escrow deposit, two config versions with rollback lineage, and
three pre-`0007` audit rows.

| Step | Result |
| --- | --- |
| `pnpm db:backup -- --env test` | `backups/sadec_test-2026-10-30T06-43-04-890Z.sql`, 32 inserts, 33 tables |
| `0007` applied over the populated `0006` DB | 10-table counts unchanged; all 3 audit rows `actor_source='app'`; `collected_vnd`/`receipt_vnd`/`escrow_vnd` all 780000 |
| `pnpm bootstrap:founder` preview | `Nothing was written`; counts identical after the preview |
| `pnpm bootstrap:founder --apply --subject-verified` | +1 workspace, +1 identity, +1 membership, +1 `provisioning` audit row; business counts unchanged |
| second `--apply` | `already holds a live founder_admin membership`; counts unchanged (4 audit rows) |
| `pnpm db:restore:test -- --env test` | restored into `sadec_test_restore`; read-back 2/2/2/1/1/1/1/1/2/3, `PRAGMA foreign_key_check` empty, money and lineage identical to the backup moment |

The delta between the restored DB and the live DB is exactly the migration plus
the bootstrap: `audit_rows` 3 → 4, and one workspace/identity/membership. That is
the evidence that a restore returns the pre-migration moment, and that undoing a
bootstrap is a restore, not a delete.

**A trap this rehearsal found:** the local D1 SQLite refuses more than five
`UNION ALL` terms (`too many terms in compound SELECT`). The widened row-count
read-back in `scripts/db-restore-test.ts` used ten, so the restore succeeded while
the read-back silently did not run and the script exited 0. It now counts ten
tables as scalar sub-selects and exits non-zero when the read-back fails;
`test/db-restore-readback.test.ts` holds the shape.

## Blocked

External items, and what each one stops:

- **No Cloudflare credentials exist in this sandbox.** `wrangler whoami` answers
  *"You are not authenticated"*, and
  `wrangler d1 migrations list sadec_pilot --remote` answers *"In a non-interactive
  environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment
  variable"*. Nothing in §6 or §8 of the runbook — identify the account, read the
  remote ledger, back up, migrate, deploy, smoke — can run without a token the
  account owner issues. `pnpm deploy:preview -- --env pilot` refuses before it
  reaches the network, on the missing Access values below, which is the guard
  working rather than the deploy being attempted.
- **The live hostnames cannot be reached from this sandbox at all.** An outbound
  `curl` to `sadec-flow.agencyos-openclaw.workers.dev` fails at TLS
  (`SSL_ERROR_SYSCALL`); the sandbox's egress allowlist covers package registries
  and GitHub, not `*.workers.dev`. So even a successful deploy could not be
  smoke-tested from here, and the absence of a live check is not evidence that a
  host is down.
- **No `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` value exists in this workspace.** They
  come from the Cloudflare dashboard. A deploy without them fails closed on
  every route, which is intended, but access cannot be verified on a real URL
  until they exist. Whoever holds the account can finish this in the steps
  written in `docs/RELEASE.md`.
- **An earlier sandbox had a token with `d1 (write)` but not `access`.** That is a
  statement about that session, not this one: this sandbox has no Cloudflare
  credential of any kind. It matters because the distinction decides what a
  future session can even attempt — a `d1`-scoped token can create databases and
  apply migrations but cannot create or inspect the Access application that
  issues the tokens, so "unauthorized visitors are blocked" stays unverified live
  until somebody with account access does it.
- **The CI gate is green — for the first time, and on the commit named here.**
  The history matters, because two different failures looked the same from
  outside. Four runs on `bb707df` and `06422d1` ended in 3–5 seconds with **zero
  steps executed**: *"The job was not started because recent account payments have
  failed or your spending limit needs to be increased."* That was an account
  billing condition on a private repository, not a test result, and no step
  (typecheck, build, tests, browser suite) had ever run on GitHub.
  `gh run rerun` and `workflow_dispatch` were both refused (the token lacks
  `actions: write`, and a run with no jobs cannot be re-run), so the pull_request
  event was re-triggered by closing and reopening PR #21 — no empty commit, no
  workflow change.
  **Run [41041229211](https://github.com/minhlongs/sadec-opc-webapp/actions/runs/41041229211)
  on `06422d1` completed `success`** in 2 m 26 s, check name **`verify`**, with all
  nine executed steps green: check out, Node 22, the declared pnpm, frozen install,
  `Verify` (30 s), database preparation, browser install (18 s), and the browser
  suite (83 s). The evidence upload is `skipped` by design — it only runs on
  failure.
  **What this does not establish:** the run proves the gate passed, not a count.
  GitHub serves job logs from `*.blob.core.windows.net`, which this sandbox cannot
  reach, so the log text itself — including the "405 tests across 37 files" line
  `scripts/verify.ts` prints and Playwright's summary — was not readable here; the
  step timings and conclusions were read from the API instead. The counts recorded
  elsewhere in this file were measured locally on the same commit. Anyone with a
  browser can open the run URL and read them.
  Deleting a workflow step, lowering a gate or adding a retry to make a check green
  remains forbidden — this gate went green with none of that.

- **The escrow account is not configured anywhere.** With no
  `ESCROW_BANK_BIN` / `ESCROW_ACCOUNT_NUMBER` / `ESCROW_ACCOUNT_HOLDER`, a
  booking shows no QR and tells the buyer not to transfer anything; the deposit
  is then recorded by a founder against a bank reference they verified. That is
  the honest state, not a bug — but it means the payment leg of a B2B booking
  has never been exercised against a real account.
- **The bootstrap has only been run against a local database.** The command, its
  SQL file, the guard and the read-back are exercised locally; a remote pilot D1
  has never been written to, because there is no Access configuration and no
  decision to point it at a real account. The first remote run is a step in
  `docs/PILOT-RUNBOOK.md`, not a claim in this file.
- **`CARRIER` damage has no cost rule.** The domain type allows it; the HTTP
  schema and the `b2b_settlements` CHECK do not. Who bears a carrier loss is a
  product decision nobody has made, and none was invented.
- **The pilot credit rule for a credit larger than the remaining obligation is a
  decision, not a proof.** Applying such a credit is refused (409) because no
  document defines partial use or a carry-forward. If the founder wants
  partial application, that is a product decision to make first.

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
