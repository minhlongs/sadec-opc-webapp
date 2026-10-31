# Operating the pilot

How the five paths fit together, what the lock covers and what it does not, what
the backup proof is worth, and what to do when one step fails.

Read `docs/DEPLOY-VIA-GITHUB.md` for the owner's configuration checklist and
`docs/R2-BACKUP-DESIGN.md` for the bucket this depends on. **Nothing in this
document has been executed**: no workflow has been dispatched, no bucket exists,
no migration has run against a remote database.

---

## 1. The paths, in order

| # | Workflow | Changes the pilot? | Takes a backup? | Run it when |
| --- | --- | --- | --- | --- |
| 1 | `ops-preflight-pilot` | no | no | first; and whenever a later step fails for no visible reason |
| 2 | `db-backup-pilot` | no | yes — export, drill, upload, receipt | on a schedule you choose; before anything you might regret |
| 3 | `db-migrate-pilot` | **yes** — schema | yes — its own, in the same run | a migration is merged and approved |
| 4 | `deploy-pilot` | **yes** — Worker | no | after 1, and after 3 if the schema moved |
| 5 | `smoke-pilot` | no | no | after 4 |
| 6 | `bootstrap-founder-pilot` | **yes** — one membership | no | once, after a human has a verified Access subject |

Each is a separate `workflow_dispatch`, each takes the full SHA of a commit on
`main` with a green `verify` run, and each refuses anything else.

## 2. The trust boundary, and why the order matters

Every operational workflow has two jobs:

1. **`verify-target`** — runs on a checkout of `main`, holds **no environment and
   no secret**, and asks the GitHub API whether the requested commit is on `main`
   with a completed, successful `verify` run of its own. It also refuses a dispatch
   from any ref other than `refs/heads/main`, because GitHub runs the workflow file
   from the selected ref: a dispatch from a branch would execute that branch's copy
   of these rules.
2. **the execute job** — declares `environment: pilot`, holds the credentials, and
   checks out `needs.verify-target.outputs.sha`. It never checks out the operator's
   input, and it refuses to continue if that output is empty (an empty `ref:` would
   silently fall back to the triggering ref, which is the whole bypass).

So the code that decides is the repository's, on `main`; the code that runs with
credentials is exactly the tree that was approved. Pinning actions to commit SHAs
does not achieve this on its own — that pins *which action* runs, not which
repository code the job executes afterwards.

## 3. The lock, and its exact scope

All four mutating workflows share **one** concurrency group (`pilot-mutations`)
with `cancel-in-progress: false`. GitHub holds a concurrency slot for the whole
run, so there is no gap between "the commit was verified" and "the deploy
happened" — the two jobs are inside the same run, and the run holds the slot.

What this does **not** cover, stated because a lock that is assumed to do more is
worse than one that does less:

- **a command run outside GitHub** — `pnpm db:migrate-pilot` from a laptop, or a
  `wrangler` call by anyone with a token, is outside the group entirely;
- **the application writing rows** while a backup is taken — the export is a
  snapshot of a moving database, not a freeze;
- **two different repositories or accounts** deploying to the same Worker;
- **the queued slot is not a reservation** — GitHub keeps one running and one
  pending run per group, so a third dispatch cancels the pending one rather than
  queueing three deep.

If a second operator or a second machine ever writes to the pilot, the honest
answer is "agree who is dispatching", not "add another lock". A distributed lock in
D1 would need a migration, a lease table and a reaper, and it still would not stop
`wrangler` from outside.

## 4. What a backup proves, and the window it leaves

`pnpm backup:receipt -- verify` accepts a backup only when all of this is true:

1. the receipt names the same **account**, **database id**, **database name** and
   **environment** as the run;
2. the object in the bucket hashes to what was exported, and the receipt's own
   read-back hash agrees;
3. the drill passed, replayed every table, left no foreign key violations and
   reported `integrity_check ok`;
4. the ledger fingerprint matches the ledger the database reports **right now**;
5. the backup is younger than the limit (24 hours by default, overridable with
   `--max-age-hours` or `SADEC_MAX_BACKUP_AGE_HOURS`, and an unreadable limit is a
   refusal rather than a silent default).

**The window:** everything written between the export and the migration commit is
not in the backup. A hash match proves the bytes are the bytes; it proves nothing
about rows appended after the export snapshot. Concretely:

- a receipt accepted 4 minutes after export means the oldest unprotected write is 4
  minutes old;
- a receipt accepted 22 hours after export means everything from those 22 hours is
  unprotected, and the freshness limit is the only thing bounding it.

**What to do about it.** The migration workflow takes its own backup in the same
run, immediately before applying — that is the whole reason the backup lives inside
the migration job rather than being handed in. It narrows the window to the seconds
between export and the first `ALTER`/`INSERT`, and it removes the case where a
"valid" receipt is a day old because someone dispatched the wrong workflow. What it
cannot do is freeze writes. For the pilot, with one operator and no scheduled jobs,
the practical mitigation is: run migrations when nobody is using the application,
and re-read the affected rows afterwards (`§5`, recovery).

**The restore point is a database, not the application.** Restoring a backup gives
back rows. It does not give back a Worker deployment, an R2 object, or an Access
policy.

## 5. Reading a failure, and recovering

| Where it failed | What it means | What to do |
| --- | --- | --- |
| `verify-target` refuses | the SHA is not on `main`, or has no successful `verify` run, or the dispatch came from another ref | nothing ran. Re-dispatch from `main` with the merge commit of a merged PR |
| execute job: "no verified commit SHA" | the verifier published nothing | nothing ran. Re-run; if it repeats, read the verifier's log |
| preflight `account id` | the token belongs to another account | fix the token/`CLOUDFLARE_ACCOUNT_ID`. **Do not edit `wrangler.jsonc` to match** |
| preflight `database sadec-pilot` | no visible database, or an id that is not the configured one | find out which side is wrong before touching either |
| preflight `bucket …` | the bucket does not exist, or cannot be read | create it only with the owner's cost approval (`docs/R2-BACKUP-DESIGN.md`) |
| preflight `bucket is private` | `r2.dev` or a custom domain is on | turn it off before any export is stored |
| preflight `bucket retention` | no expiry rule, or one shorter than 30 days | fix the lifecycle rule |
| export step | `wrangler d1 export` failed, or produced a tiny file | **no backup, no migration.** Read the export log; do not continue |
| drill step | the export does not replay | the backup is not a recovery point. Do not migrate; investigate before taking another |
| read-back step | the stored object differs from the export | the upload is not trustworthy. Nothing was published; re-run the backup |
| receipt verify | one of the five conditions in §4 | the message names the field. Fix the cause, not the receipt |
| conflict check (`CONFLICT`) | the remote ledger records a migration whose file this tree lacks | **stop.** Check out the commit that migration came from |
| migration step | `db:migrate-pilot` failed | the ledger may be partly applied. Read it before doing anything else |
| read-back after migrate | migrations are still pending | do not report success; read the ledger by hand |
| smoke readiness | the app does not serve | do not redeploy as a reflex. A `503 catalog_unavailable` means the binding or the data, and a redeploy fixes neither |
| bootstrap | the grant was not written | read the audit row back before re-running; never change the subject and resend blindly |

**Restoring a backup** (a decision, not a workflow): replay the object into a
database — never over pilot — with
`node scripts/db-restore-drill.ts --env pilot --file <downloaded export>`, which is
exactly the drill. Promoting that replayed database to be the live one is a manual,
deliberate act, and it is not automated here on purpose: a restore that can be
triggered by a button is a restore someone will trigger to "fix" a UI problem.

## 6. What remains a human gate

- a real Access login, and a save that survives a reload;
- the Access application's policy on the Worker hostname;
- that the deployed Worker holds the same `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` the
  deploy passed — a non-empty GitHub secret proves nothing about the Worker;
- the founder subject, read from a verified identity;
- any payment: no receiving account is configured, QR stays off, payOS stays on
  hold.

`scripts/preflight-facts.ts` prints `ACCESS LOGIN NOT VERIFIED` on every run,
including a passing one, so that a green preflight is not read as a usable pilot.
