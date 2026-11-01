# Pilot configuration checklist — what the owner creates, in order

This is the short version of the provisioning work. It exists so the owner can set up
the two systems in one sitting, and it names **exactly** the identifiers the merged
code reads.

**State: nothing here has been done.** No R2 bucket exists, no GitHub Environment
exists, no secret has been entered, no workflow has been dispatched, and no deploy,
migration or bootstrap has run. The preflight for a backup or a migration fails until
the bucket, its lifecycle rule and its lock rule exist — that is intended.

Companion documents, for the reasoning rather than the steps:
`docs/R2-BACKUP-DESIGN.md` (§4 permissions, §5 retention, §6 cost, §7 provisioning),
`docs/DEPLOY-VIA-GITHUB.md` (§2 the GitHub Environment, §3 permissions per operation),
`docs/OPERATIONS-PILOT.md` (the paths and their order).

---

## 1. Cloudflare R2

### 1.1 The bucket

| Setting | Value the code expects | Why |
| --- | --- | --- |
| name | `sadec-pilot-backups` | the default in `scripts/preflight-facts.ts` (`BACKUP_BUCKET_NAME`); override only with the `R2_BACKUP_BUCKET` variable, and both must agree |
| storage class | **Standard** | the cost table in §6 is Standard; Infrequent Access has a 30-day minimum and a retrieval charge that a restore would pay |
| location / jurisdiction | **Automatic** (no hint) | there is no Asia-Pacific jurisdiction; only EU/US are guaranteed, and the choice is fixed at creation (`docs/R2-BACKUP-DESIGN.md` §2) |
| public access | **off** | `dev-url` disabled, no custom domain. The preflight fails on either switch being on: a public bucket holding a pilot export is a breach, not a preference |
| encryption | Cloudflare-managed, AES-256-GCM, at rest | service-side. This design does **not** do client-side encryption, and does not call it that |

### 1.2 Prefixes

| Prefix | Holds | Written by |
| --- | --- | --- |
| `pilot/` | the exports (`pilot/<database>-<timestamp>-run<id>-attempt<n>.sql`) | `.github/actions/pilot-backup` |
| `receipts/` | one JSON receipt per stored backup, named after the object key | the same action, after the read-back drill |

The receipt is written **outside** the export prefix on purpose: it is the audit trail
of what was stored, and expiring it would delete the evidence while the object still
exists.

### 1.3 The two rules, and why they are not the same rule

Both are **required** for a backup or a migration. Neither is advisory; the preflight
treats a missing one as a failure and the workflow stops.

```bash
# Expiry: exports are deleted 30 days after they are written.
pnpm exec wrangler r2 bucket lifecycle add sadec-pilot-backups \
  --name expire-pilot-exports --prefix "pilot/" --expire-days 30

# Lock: exports cannot be overwritten or deleted for 30 days.
pnpm exec wrangler r2 bucket lock add sadec-pilot-backups retain-30d "pilot/" \
  --retention-days 30

# Both must confirm the bucket is private.
pnpm exec wrangler r2 bucket dev-url disable sadec-pilot-backups
pnpm exec wrangler r2 bucket domain list sadec-pilot-backups   # expect empty
```

Argument shapes are as printed by `wrangler 4.152.0`, which is the version this
repository pins; check `--help` on your own machine before running them, and note that
these commands have **not** been run from here — creating the bucket is the owner's
decision, not the agent's.

What each rule does, and what it does **not**:

| | Applies to | Several rules on `pilot/` | A rule on another prefix |
| --- | --- | --- | --- |
| expiry | `pilot/` — the export prefix | the **earliest** age wins: the object is deleted when the first matching rule comes due | contributes nothing; a 30-day rule on `other/` is not retention for `pilot/` |
| lock | `pilot/` — the export prefix | the **latest** duration wins: the object stays protected while any matching rule holds it | contributes nothing; a lock on `other/` protects nothing this job writes |

Effective retention is the **longer** of the two, because an object inside its lock
window is not removed by the expiry rule. Two practical consequences:

- **Do not scope a delete rule to the whole bucket.** It would expire `receipts/` too;
  the preflight reports that (INFO) rather than failing, because losing the receipts
  makes an old backup unauditable. Prefix-scope the expiry to `pilot/`.
- **Do not add a lock over `receipts/`.** A receipt is written after the object it
  describes, and a wrong-bucket receipt is worth being able to correct. The receipt
  path is keyed by the object key including the run attempt, so no workflow overwrites
  one.
- **Do not remove or shorten the lock to make a job pass.** If the preflight refuses,
  the rule is what is wrong with the setup, and a job that cannot store a protected
  backup is a job that must not run.

### 1.4 Credentials

Three different things are called "a token" in this project; only the middle one is
entered anywhere.

| Credential | What it is | Who creates it | Where it lives |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | the Actions run's own token | GitHub, automatically, per job | never entered; scoped in each workflow's `permissions:` block |
| **Cloudflare API token** | what `wrangler` in the workflows uses | you, in the Cloudflare dashboard | GitHub Environment `pilot` secret `CLOUDFLARE_API_TOKEN` |
| R2 S3 access key / secret | the S3-compatible pair | you, if you ever use an S3 client | **not used** by this design; no workflow reads one |

Minimum scopes for that one API token, and what must stay off it:

| Operation | Needs |
| --- | --- |
| preflight reads of account, D1, Worker | Account: Read, D1: Read, Workers Scripts: Read |
| preflight of bucket, lifecycle, lock, domains | + **Workers R2 Storage Read** |
| upload the export, read it back | + **Workers R2 Storage Bucket Item Write**, scoped to `sadec-pilot-backups` |
| export / migration | + D1: Edit (migration only) |
| deploy the Worker | + Workers Scripts: Edit |

Deliberately absent: account-level `Workers R2 Storage Write` (it can create buckets and
edit lifecycle and lock — the retention policy must not be something the backup job can
change), any delete-object permission, and `Access: Edit`.

### 1.5 Cost

A **conditional estimate**, not a promise of a free resource. Standard class, prices as
read on 2026-10-30: storage $0.015/GB-month, Class A $4.50/million, Class B
$0.36/million, egress free, monthly free allowance 10 GB-month + 1M Class A + 10M Class
B.

- Per run: 1 export put (Class A), 1 read-back (Class B), 1 receipt put (Class A) →
  **2 Class A + 1 Class B**.
- Assumed 50 MB per export, 2 backups a day, 30-day retention → 60 objects ≈ 3 GB-month
  and 120/60 operations a month → **inside the free allowance, so ≈ $0**, *if* the free
  allowance is still available to this account and the export stays near 50 MB.
- The first thing that would leave the allowance is storage at 10 GB: at 50 MB per
  export that is 200 retained objects, i.e. about 100 days of two-a-day backups.
- **Excluded from this estimate:** GitHub Actions minutes, D1 storage and reads,
  Cloudflare plan and Access seat costs, a second copy of the backups (this design has
  none), and operator time. Re-read the pricing page before approving.

How to watch it: the R2 dashboard shows storage and Class A/B operations for the
bucket; the free-allowance bar is on the R2 overview. Check it after the first week of
real backups rather than after the first bill.

---

## 2. GitHub

### 2.1 The Environment

Workflows that hold a secret declare `environment: pilot`; the jobs that decide
*whether* to run declare no environment and hold no secret. Create the environment
yourself, because a workflow naming a missing environment creates one with no
protection rules:

**Settings → Environments → New environment → `pilot`**

- **Required reviewers**: add yourself **if the plan offers it**. This account has zero
  environments today, so whether the control is available here is **unverified** —
  record it rather than assuming it.
- **Deployment branches**: restrict to `main` if the control exists.

### 2.2 Names, exactly as the code reads them

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | the token from §1.4 |
| `ACCESS_TEAM_DOMAIN` | secret | Zero Trust → Access → the application's team domain |
| `ACCESS_AUD` | secret | the same application → Additional settings → Application Audience tag |
| `CLOUDFLARE_ACCOUNT_ID` | **variable** | `f691e83094f776311a1bfe3f8b126f1c` — an id, not a credential; the preflight compares it |
| `R2_BACKUP_BUCKET` | **variable** | `sadec-pilot-backups` (optional; that is the default) |
| `SADEC_MAX_BACKUP_AGE_HOURS` | variable | optional; leave unset for the 24-hour default a migration accepts |

**No repository-level secrets.** Every workflow that touches Cloudflare declares
`environment: pilot`, so only a job that declares it can read these; a repository
secret would be readable by any workflow.

### 2.3 Two Access configurations, in two places

They are separate values that must match, and a mismatch is not visible from GitHub:

| Where | Set by | Read by |
| --- | --- | --- |
| GitHub Environment secret | you, once, at §2.2 | the deploy job, which passes them to `wrangler` |
| **Worker secret** on `sadec-flow-pilot` | you, from a machine you control | the deployed Worker, on every request |

```bash
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN --name sadec-flow-pilot
pnpm exec wrangler secret put ACCESS_AUD         --name sadec-flow-pilot
pnpm exec wrangler secret list  --name sadec-flow-pilot   # names only, never values
```

The preflight can confirm the GitHub values are **present**; nothing in it proves the
deployed Worker holds the same ones. That is `docs/PILOT-GATES.md`'s business, and it
needs a real login.

---

## 3. Readiness table

Print this, tick each line after doing it, and keep it with the runbook. **No secret
value is written on it** — only that the thing exists.

| # | Check | How to confirm | Done |
| --- | --- | --- | --- |
| 1 | Environment `pilot` exists | Settings → Environments lists it | ☐ |
| 2 | Reviewer / branch restriction set, or recorded as unavailable | the environment's protection rules page | ☐ |
| 3 | Secrets present: `CLOUDFLARE_API_TOKEN`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | the environment's Secrets list (names only) | ☐ |
| 4 | Variables present: `CLOUDFLARE_ACCOUNT_ID`, `R2_BACKUP_BUCKET` | the environment's Variables list | ☐ |
| 5 | Bucket `sadec-pilot-backups` exists, Standard class | `pnpm exec wrangler r2 bucket list` | ☐ |
| 6 | Bucket is private: `dev-url` off, no custom domain | `dev-url get`, `domain list` (both empty) | ☐ |
| 7 | Expiry rule on `pilot/`, 30 days | `pnpm exec wrangler r2 bucket lifecycle list sadec-pilot-backups` | ☐ |
| 8 | Lock rule on `pilot/`, 30 days | `pnpm exec wrangler r2 bucket lock list sadec-pilot-backups` | ☐ |
| 9 | API token scopes as §1.4, bucket-scoped for Item Write | the token's page in the dashboard | ☐ |
| 10 | Worker secrets `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` set | `pnpm exec wrangler secret list --name sadec-flow-pilot` | ☐ |
| 11 | Cost understood and approved | §1.5 read, with the exclusions | ☐ |

## 4. The first thing to run afterwards — not yet

One workflow, read-only, and nothing after it until its output has been read:

**Actions → `ops-preflight-pilot` → Run workflow**

| Input | Value |
| --- | --- |
| `sha` | the full 40-character SHA of a commit **on `main`** with a successful `verify` push run |
| `purpose` | `backup` — the only purpose that asks the bucket questions |

It dispatches on the default branch and checks the SHA before running. What a pass
means: the token can read the account; `sadec-pilot` exists with the id
`wrangler.jsonc` binds; the Worker's presence is confirmed; the Access values are
present; the bucket exists, is private, and its **own** rules retain and lock `pilot/`
for 30 days.

What it does **not** mean: that a backup has ever been stored (no upload has run), that
a person can sign in, or that the pilot is usable. Those are separate gates. Read the
output before deciding the next step; do not chain a backup run onto a green preflight
in the same sitting without looking at it.
