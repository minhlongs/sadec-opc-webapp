# Handoff — Claude Code in Orca IDE

Written 2026-11-01 by the Arena session that prepared the GitHub deployment path.
This file exists so the next session does not have to read a conversation: it
states what is true *now*, what is only historical, and the one step that comes
first.

**Read order:** this file → `docs/CHECKPOINT.md` (status) →
`docs/PILOT-CONFIG-CHECKLIST.md` (what the owner must create) →
`docs/OPERATIONS-PILOT.md` (the paths and their order) → `docs/DECISIONS.md`
(why the code looks like this). `docs/HANDOVER.md` is the longer technical
handover; this one is the session handover.

---

## 1. The goal

Take the shipped code to a **pilot that is live with evidence**, one gated step at
a time: preflight → backup → migration → deploy → Access sign-in → a save that
survives a reload.

Not in scope, and not to be restarted: rebuilding the product, re-opening the
payOS research, or adding features. The product is built; what is missing is
**configuration on two systems and the remote evidence that follows it**.

---

## 2. What is finished

Everything below is in the tree at
`f7a7b10a56ba98b3a675bdabb29accd0c9d72908` and is covered by the local gate.

| Area | State | Where it lives |
| --- | --- | --- |
| **Nursery Ops** | full pipeline: customers, orders, supply lots, deliveries, shipment packages, follow-ups, change proposals | `src/ops/`, migrations `0001`–`0005` |
| **Founder surface** | discovery interviews/observations, configuration versions with lineage, active-config pointers, transactions | `src/founder/`, migrations `0004`, `0006` |
| **B2B Floriculture** | quote chains/revisions/drafts, escrow ledger, receipts, escrow settlement, idempotency keys | migrations `0003`, `0005` |
| **Authorization** | one chokepoint, `src/security/authorize.ts`; every route goes through it | `src/security/`, `test/authorize.test.ts`, `test/tenant-boundary.test.ts` |
| **Access verification** | `src/security/verify-access-token.ts` — JWKS-based, fails closed; `src/security/dev-identity.ts` is demo/test only and must never be enabled for pilot | `test/verify-access-token.test.ts`, `test/worker-auth.test.ts` |
| **Money** | integer VND, server-side totals, ledger derived from receipts only; no client-supplied totals | `src/domain/`, `test/money.test.ts`, `test/escrow-ledger.test.ts` |
| **Immutable records** | append-only audit trail, revision/config lineage, `REVOKE`-style rules in SQL | `test/migration-0007.test.ts`, `migrations/0007_audit_provisioning_actor.sql` |
| **Bootstrap** | preview-then-apply, exactly one `founder_admin`, audit row recording the declared operator/subject | `scripts/bootstrap-founder.ts`, `test/founder-bootstrap.test.ts` |
| **Smoke** | a live check that exits non-zero rather than printing curl output for a human to read | `scripts/smoke-live.ts`, `test/smoke-live.test.ts` |
| **Six manual workflows** | `ops-preflight-pilot`, `db-backup-pilot`, `db-migrate-pilot`, `deploy-pilot`, `smoke-pilot`, `bootstrap-founder-pilot` — each `workflow_dispatch`, each taking a full SHA on `main` with a green `verify` run | `.github/workflows/` |
| **The SHA gate** | a job with no environment and no secret decides from the GitHub API, then publishes a fixed output that is the only path to a checkout | `scripts/verify-target-sha.ts`, `scripts/deploy-ref.ts` |
| **Backup** | export → drill → `put` → read back → drill **the read-back file** → receipt → `verify` | `.github/actions/pilot-backup/action.yml`, `scripts/backup-receipt.ts`, `scripts/db-restore-drill.ts` |
| **Receipts** | v2: each phase timestamped, ledger taken from the restored copy, `drilledFrom` recorded, attempt-aware key | `scripts/backup-receipt-rules.ts` |
| **Preflight** | read-only; per-rule prefix/duration evaluation for lifecycle and lock, each kind with its own semantics | `scripts/preflight-facts.ts`, `scripts/cf-preflight.ts` |

### The security fixes worth knowing about (each was a real defect)

1. The Worker never built a verifier from its environment → every request refused.
2. The origin guard demanded a header a browser cannot send.
3. The pilot deploy read a generated config with no database binding and no `APP_ENV`.
4. The SHA check ran *from* the tree it was approving → moved in front of the checkout.
5. The ancestor check asked `compare/main...<sha>` and accepted `ahead`, i.e. it
   accepted **unmerged** commits.
6. A `workflow_dispatch` run counted as the release gate, and a missing
   `head_branch` defaulted to `main`.
7. The preflight summarised bucket rules before judging them, so a 30-day rule on
   `other/` answered for a 7-day `pilot/`.
8. A missing bucket lock was logged as information and the job continued.

### GitHub artefacts of this line of work

| Commit | PR | Merge SHA | CI on `main` |
| --- | --- | --- | --- |
| trusted SHA gate + backups | [#27](https://github.com/minhlongs/sadec-opc-webapp/pull/27) | `b3da79653775a5a1741c652ce30402fdf2fda0d5` | run 41202814493, `verify` success |
| round-18 review fixes | [#28](https://github.com/minhlongs/sadec-opc-webapp/pull/28) | `3a1f6db2fd947e4b07c695010667a5a643959734` | run [41293009760](https://github.com/minhlongs/sadec-opc-webapp/actions/runs/41293009760), `verify` success |
| lock wording + config checklist | [#29](https://github.com/minhlongs/sadec-opc-webapp/pull/29) | `f7a7b10a56ba98b3a675bdabb29accd0c9d72908` | run [41293594243](https://github.com/minhlongs/sadec-opc-webapp/actions/runs/41293594243), `verify` success |

Test counts are **not** inherited between sessions. The number that belongs to
`f7a7b10` is whatever `pnpm verify` prints there; the Arena session measured
**708 tests across 45 files** on 2026-11-01 and CI `verify` passed on the same
SHA. If your checkout reports a different number, one of us is on a different
commit.

---

## 3. What is not finished

Nothing in this list has been done, and no document in this repository claims
otherwise.

| # | Missing | Status today |
| --- | --- | --- |
| 1 | GitHub Environment `pilot` | **not verified.** `GET /repos/…/environments` and GraphQL both return `total_count: 0` |
| 2 | Environment secrets/variables | **not verified.** The listing endpoints answer `403` for the Arena token, so not even the *names* could be read |
| 3 | R2 bucket, lifecycle rule, lock rule, private access | **not verified remotely.** No bucket has been created or read by a workflow |
| 4 | Preflight | **never run.** `ops-preflight-pilot` has zero runs |
| 5 | Backup, upload, read-back, restore drill **remote** | **no evidence.** Everything proven is a local replay of a local export |
| 6 | Migration on the pilot database | **not run.** The pilot database is not known to be at `0007` |
| 7 | Deploy | **not run** by any workflow |
| 8 | Access sign-in, save, reload | **not performed.** Local tests cover real/forged/absent tokens; nobody has signed in |
| 9 | Founder bootstrap against the pilot database | **not run.** The subject must come from a real login, and has not been chosen |
| 10 | payOS, bank collection/payout, `vietqr` against a real account | **HOLD.** Documentation only; no fee invented; no money movement of any kind |

`DEMO_LIVE_VERIFIED` and `PILOT_LIVE_VERIFIED` are both **no**. Earlier release
notes record Workers deployed at remote schema `0004` by an *earlier* session;
this line of work re-deployed nothing and re-verified no live URL.

---

## 4. Blockers, separated by kind

These are different problems with different owners. Do not merge them into one
"it doesn't work".

### 4.1 GitHub dispatch permission — blocks this session, not the project

`gh workflow run ops-preflight-pilot.yml --ref main -f sha=… -f purpose=backup`
returns:

```
HTTP 403: Resource not accessible by integration
(…/actions/workflows/402734241/dispatches)
```

The token's *repository role* reports `admin: true`, so this is **not** a role
problem: the GitHub App installation behind the Arena session lacks **Actions:
write**. Read access works (workflow runs list fine); write does not, and
`/actions/permissions` and `/actions/secrets` also answer 403 for the same reason.

- **Fix A (preferred):** the owner runs the workflow from the GitHub UI — see §6.
- **Fix B:** grant the Arena GitHub App `Actions: read and write` in the
  installation settings, then dispatch again.
- **Not a fix:** closing/reopening a PR, pushing an empty commit, dispatching a
  different workflow, or editing the workflow to run on `push`. Each of those
  bypasses a control rather than satisfying it.

### 4.2 Cloudflare permissions — unknown until the preflight says so

The API token must carry, at minimum: Account:Read, D1:Read (+D1:Edit for a
migration), Workers Scripts:Read (+Edit for a deploy), **Workers R2 Storage
Read**, and **Workers R2 Storage Bucket Item Write scoped to
`sadec-pilot-backups`**. It must **not** carry account-level
`Workers R2 Storage Write`, any delete permission, or `Access: Edit`. The
preflight names the operation a 403 belonged to; believe it rather than widening
the token.

### 4.3 Network reachability — a sandbox fact, not a pilot fact

Cloudflare is unreachable from the Arena sandbox at the transport layer while
GitHub answers normally. That is why deployment lives on GitHub Actions. **Do not
retry Cloudflare from a sandbox**; if Orca's machine can reach it, use the CLI
paths, and if it cannot, use the workflows.

### 4.4 Environment configuration — the most likely real blocker

An environment that does not exist is created **by the first job that names it,
with no protection rules**. Dispatching before it exists therefore does not just
fail; it produces an unprotected `pilot` environment. Create it first, with the
names in `docs/PILOT-CONFIG-CHECKLIST.md` §2. Its most likely cause is a
mismatch of surface: environment and secrets created in a *different repository*
or at *repository* scope instead of environment scope.

### 4.5 The Founder's real Access subject — a person's decision

The bootstrap needs the `sub` from a **real** Access login of the person who will
be the founder admin. It must not be guessed, must not be the first identity that
happens to log in, and must not be read from a token pasted into a chat. Until
someone signs in and the subject is confirmed, `bootstrap-founder-pilot` stays
unrun.

---

## 5. Decisions that must not be undone

| Decision | Why |
| --- | --- |
| **Authorization goes through `src/security/authorize.ts`** | one chokepoint, so a route that skips it is visible; do not add a second path "just for this endpoint" |
| **Money is integer VND, totals computed on the server** | a client-supplied total is a pricing bug and a fraud vector |
| **Revisions, config versions and the audit trail are immutable** | append-only; corrections are new rows, never updates |
| **Only collected money can be paid out** | no platform-funded advance, no negative balance, ever |
| **Manual funding is allowed; automated bank collection is not implemented** | the bank/payout leg stays locked until a separate approved round |
| **No QR without a real, confirmed receiving account** | a QR pointing at an unknown account is worse than no QR |
| **R2 is private, with lifecycle expiry *and* bucket lock on `pilot/`** | the lock is required, not advisory: a unique key does not stop a second `put` from replacing the bytes behind a receipt |
| **A green CI run is not a live pilot** | and neither is an HTTP `401` |
| **payOS stays HOLD** | documentation only; Bảo Kim is a wallet/connectivity partner, not a bank |

Also standing: never write secrets into the repository, a document, an issue or a
chat; never weaken a script's environment guard to make a workflow pass; never
patch a database to make a screen look right.

---

## 6. Taking over in Orca

```bash
# 1. Get the code, without touching anything local
git clone https://github.com/minhlongs/sadec-opc-webapp
cd sadec-opc-webapp
git fetch origin
git log --oneline -5 origin/main        # expect f7a7b10 or a later merge
git status                              # must be clean before you do anything

# 2. If there is an existing checkout with local work: keep it.
#    stash or commit it, never `git reset --hard`, never `git push --force`.

# 3. Baseline before you change anything
corepack enable
corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
pnpm install --frozen-lockfile
pnpm verify                             # typecheck + build + tests; must be green
```

**Do not depend on `/home/user/...`.** That is the Arena sandbox's path and means
nothing in Orca. Everything below is repository-relative.

### Files to read, in this order

| Read | For |
| --- | --- |
| `docs/CHECKPOINT.md` | what is true today, and the review rounds that fixed things |
| `docs/PILOT-CONFIG-CHECKLIST.md` | the exact names to create on Cloudflare and GitHub, the cost basis, and the readiness table |
| `docs/OPERATIONS-PILOT.md` | the six paths, their order, and the one lock |
| `docs/R2-BACKUP-DESIGN.md` | bucket, prefixes, retention/lock semantics, permissions, cost |
| `docs/DEPLOY-VIA-GITHUB.md` | the GitHub Environment, permission scopes, and the checks each failure means |
| `docs/PILOT-GATES.md` | the nine gates and which are genuinely passed |
| `docs/DECISIONS.md` | why the chokepoint, the immutability rules and the money rules exist |

### The commands that matter

| Command | What it does |
| --- | --- |
| `pnpm verify` | the gate: typecheck, production build, full test run |
| `pnpm preflight:cloudflare -- --purpose backup --bucket <name>` | read-only account/D1/Worker/Access/R2 check |
| `pnpm verify-target-sha -- --sha <full> --dispatch-ref <ref>` | the dispatch gate, runnable locally with `GH_TOKEN` |
| `pnpm db:restore:drill -- --env pilot --file <export> --drilled-from bucket-readback` | replay an export into a throwaway SQLite |
| `pnpm backup:receipt -- target\|key\|create\|verify` | build or check a receipt |
| `pnpm db:migration-drift -- --ledger <json>` | compare the tree's migrations with a ledger |
| `pnpm db:migrate-pilot -- --env pilot --confirm sadec_pilot` | apply migrations — **guarded, and not part of this handoff** |

`pnpm <script> -- <args>` forwards a literal `--`; the scripts tolerate it, and
the workflows call `node scripts/…` directly wherever stdout is captured.

### Workflows

| Workflow | Purpose | Runs today |
| --- | --- | --- |
| `verify` | the gate on every push | always; the only workflow that has ever run |
| `ops-preflight-pilot` | read-only target check | **never** |
| `db-backup-pilot` | export → drill → store → read back → receipt | **never** |
| `db-migrate-pilot` | takes its own backup, verifies it, then migrates | **never** |
| `deploy-pilot` | build and upload the Worker | **never** |
| `smoke-pilot` | readiness, no secret at all | **never** |
| `bootstrap-founder-pilot` | the one-time founder admin | **never** |

Every operational workflow takes `sha` (full 40 characters) and refuses a commit
that is not on `main` with a `push` run of `verify` for that exact SHA.

---

## 7. The first step, concretely

### 7.1 Read-only verification (do this first, change nothing)

```bash
# Is main what we think it is?
git fetch origin && git rev-parse origin/main
gh run list --branch main --limit 5 --json databaseId,workflowName,event,conclusion,headSha
# expect: verify / push / success on that SHA

# Does the environment exist, and are there protection rules?
gh api repos/minhlongs/sadec-opc-webapp/environments
# 0 means it does not exist — stop and create it (PILOT-CONFIG-CHECKLIST §2)

# Can this session dispatch?
gh workflow list --all | grep ops-preflight
gh api repos/minhlongs/sadec-opc-webapp/actions/workflows
```

If `environments` is 0, **do not dispatch**: the run would create an unprotected
environment and fail on empty secrets. If dispatch is 403, use the UI.

### 7.2 Then the one operational step

| Input | Value |
| --- | --- |
| Workflow | `ops-preflight-pilot` |
| Ref | `main` |
| `sha` | the **full 40-character SHA** of `main` that has a successful `verify` **push** run (today: `f7a7b10a56ba98b3a675bdabb29accd0c9d72908`) |
| `purpose` | `backup` |

From the UI: Actions → `ops-preflight-pilot` → *Run workflow* → branch `main`,
paste the SHA, choose `backup`. If an environment approval is required, wait for
the person who can approve it; do not remove the protection.

Read the output line by line: `token`, `account id`, `account access`,
`database sadec-pilot`, `worker sadec-flow-pilot`, `Access configuration present`,
`bucket sadec-pilot-backups`, `bucket is private`, `bucket retention`,
`bucket lock`, `receipts excluded from expiry`. `Access configuration matched` is
**INFO / NOT CHECKED** by design, even on a full pass.

Then stop and read it. **Do not chain a backup run onto a pass.** What a pass
means is narrow: the token can see the account, the database id matches
`wrangler.jsonc`, the bucket is private, and the bucket's own rules retain and
lock `pilot/`. It does not mean an object was ever stored, and it does not mean
anyone can sign in.

---

## 8. Red lines for the next session

- No merge, dispatch, migration, deploy or bootstrap "to see if it works".
- No bucket creation, no lock removal, no opening public access to make a check
  pass. A refusing preflight is telling you the setup is wrong.
- No secrets in chat, commits, docs, issues or logs. Names only, never values.
- No `git reset --hard`, no force-push, no rewriting `main`.
- No dev identity or weakened auth to get into the pilot.
- No money movement, no payOS integration, no real bank transfer or payout call.
- No claim of "live", "restored", "signed in" or "deployed" without a run URL or
  a person's observation behind it.

## 9. Where the evidence lives

| Claim | Evidence |
| --- | --- |
| The gate is green on `f7a7b10` | run [41293594243](https://github.com/minhlongs/sadec-opc-webapp/actions/runs/41293594243), `verify`, push, `main` |
| The preflight reads a rule with its prefix | `test/cf-preflight.test.ts` (58 cases), `test/preflight-cli.test.ts` (11, runs the real CLI against a stubbed API) |
| A receipt cannot outlive its ledger | `test/backup-receipt.test.ts` (47 cases) |
| The dispatch gate refuses unmerged commits | `test/deploy-ref.test.ts` (37), `test/verify-target-sha.test.ts` (23) |
| The workflows contain the checks they claim | `test/workflows.test.ts` (102) |

Local evidence from the Arena session — a throwaway local D1, **not** Cloudflare:
export 33,280 bytes → drill of the read-back file → 33 tables in the restored
database, 0 foreign-key violations, `integrity ok`, 10 chain checks at 0 orphans,
7 migrations in the snapshot ledger, content digest `a0f4cf5c…` → receipt →
`verify` **ACCEPTED** against a matching live ledger and **REFUSED** against a
shortened one. The migrations declare 31 application tables plus `d1_migrations`;
the drill counts every table the database contains, which is why its number is
higher. That evidence says the pipeline works on a local file. It says nothing
about R2 or D1 in production.
