# Deploying from GitHub, by hand

The owner's checklist for the deployment path: GitHub Actions runs the work, and
the owner enters the credentials. **Nothing here has been run yet** — no workflow
has been dispatched, no GitHub Environment exists, no R2 bucket exists, and no
deploy, migration or bootstrap has happened. This is preparation, and it says "ready
to run", not "live".

Companion documents: `docs/OPERATIONS-PILOT.md` (the paths, the lock, recovery),
`docs/R2-BACKUP-DESIGN.md` (the bucket, its cost and its permissions),
`docs/PILOT-GATES.md` (what still needs a person).

---

## 1. Why this exists

Deploying from the assistant's sandbox was blocked twice: no Cloudflare credential
there, and Cloudflare unreachable from it at the transport layer
(`SSL_ERROR_SYSCALL`) while GitHub answered normally. GitHub Actions is reachable,
holds the repository's own secrets, and records an auditable run per operation.

**Nobody types a secret into a chat, an issue, a pull request or a repository
file.** The owner enters them on GitHub, once, in the environment below.

## 2. Create the GitHub Environment first

A workflow that names an environment GitHub has never seen creates it **with no
protection rules**, so create it yourself:

**Settings → Environments → New environment → `pilot`.**

- Add yourself under **Required reviewers** if the plan offers it. This account has
  **zero environments today**, so whether that control is available here is
  **unverified** — record it rather than assuming it.
- Restrict *Deployment branches* to `main` if the control exists.

Then add, on that environment:

| Name | Kind | Value / source |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | one token, scopes in §3 |
| `ACCESS_TEAM_DOMAIN` | secret | Zero Trust → Access → the application |
| `ACCESS_AUD` | secret | same application → Additional settings |
| `CLOUDFLARE_ACCOUNT_ID` | **variable** | `f691e83094f776311a1bfe3f8b126f1c` — not a credential, and the preflight compares it |
| `R2_BACKUP_BUCKET` | **variable** | `sadec-pilot-backups` (optional; that is the default) |

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are **also Worker secrets**, and a workflow
must not set those (it would put the value on a command line). Set them once from a
machine you control:

```bash
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN --name sadec-flow-pilot
pnpm exec wrangler secret put ACCESS_AUD          --name sadec-flow-pilot
pnpm exec wrangler secret list  --name sadec-flow-pilot   # names only
```

**No repository-level secrets.** Every workflow declares `environment: pilot`, so
these values are readable only by a job that declares it. A repository secret would
be readable by any workflow — the exposure this split exists to avoid.

`CLOUDFLARE_API_TOKEN` may need `SADEC_MAX_BACKUP_AGE_HOURS`? No — that is an
optional *variable* only if you want a limit other than the 24-hour default. Leave
it unset to accept the default.

## 3. Cloudflare permissions, per operation

| Operation | Workflow | Scopes |
| --- | --- | --- |
| read account, D1, Worker | `ops-preflight-pilot` | Account: Read, D1: Read, Workers Scripts: Read |
| read bucket config, lifecycle, lock, public domains | preflight of backup/migrate | + **Workers R2 Storage Read** |
| export | `db-backup-pilot`, `db-migrate-pilot` | D1: Read is what an export should need. **Not verified against the live API.** The same token also needs D1: Edit for the migration, so in practice it carries both |
| upload and read back one object | the same two | + **Workers R2 Storage Bucket Item Write**, scoped to `sadec-pilot-backups` |
| apply migrations, bootstrap | `db-migrate-pilot`, `bootstrap-founder-pilot` | + D1: Edit |
| upload the Worker | `deploy-pilot` | + Workers Scripts: Edit |
| smoke | `smoke-pilot` | **none** — it holds no secret at all |

Not needed anywhere, and better absent: `Workers R2 Storage Write` at account level
(bucket creation and config), any `Access: Edit`, and any token with delete rights
on the bucket. Retention is a lifecycle rule set once by hand, not something the
backup job can change.

## 4. The paths and their order

Full detail in `docs/OPERATIONS-PILOT.md`. In short:

1. `ops-preflight-pilot` — read-only; run first, and again when something fails.
2. `db-backup-pilot` — export → drill → upload → read back → receipt.
3. `db-migrate-pilot` — takes **its own** backup in the same run, verifies the
   receipt, conflict-checks the ledger, migrates, reads the ledger back.
4. `deploy-pilot` — build and upload.
5. `smoke-pilot` — readiness and fail-closed evidence, no secret.
6. `bootstrap-founder-pilot` — once, with a subject from a verified identity.

**There is no demo path.** No `deploy:demo` command, no guarded remote-migration
path for the demo database and no demo Access configuration exist; adding one from
a workflow would be a new unguarded write path.

### Choosing the commit

Every dispatch asks for one input: `sha` — the **full 40-character SHA** of a commit
already on `main`.

A job with **no secret** verifies it, from a checkout of `main`: shape, ancestry on
`main` (GitHub's compare API), and a **completed, successful `verify` run for that
exact commit**, triggered by a push to `main`. A branch name, a tag, a short SHA, a
commit from a branch, a pull-request run (which tests a merge commit) and an
unreadable API are all refusals. Only its output reaches the checkout that builds.

**Dispatch from `main`.** The workflow refuses any other ref: GitHub runs the
workflow *file* from the selected ref, so a branch dispatch would run that branch's
copy of every rule.

## 5. Reading results

| What you see | What it means |
| --- | --- |
| verifier refuses: "not a full 40-character commit SHA" | nothing ran. Use the merge commit of a merged PR |
| verifier refuses: "is not on main" | that commit is not merged. Open the PR first |
| verifier refuses: "no successful run" | CI has not passed on that exact commit, or it passed on a PR rather than a push to `main` |
| verifier refuses: "dispatched from …" | you picked a branch. Re-dispatch from `main` |
| execute job: "no verified commit SHA was published" | the hand-off failed. Nothing ran |
| preflight `account id` | the token is for another account. Fix the token — never edit `wrangler.jsonc` to match |
| preflight `database sadec-pilot` | no database with that name, or an id that is not the id the config binds. Find out which side is wrong first |
| preflight `worker …` (deploy) | the Worker could not be confirmed. 403 = missing Workers Scripts:Read; 5xx = try later. **Neither is permission to deploy** |
| preflight `bucket …` / `bucket is private` / `bucket retention` | create the bucket only with cost approval; turn off `r2.dev`; add the 30-day expiry |
| drill fails | the export does not replay. **Do not migrate.** A backup that fails its drill is not a backup |
| read-back hash mismatch | the stored object is not the export. Nothing was published; re-run |
| receipt REFUSED | the message names the field: wrong target, old backup, different ledger, failed drill, or an object that does not match |
| conflict check `CONFLICT` | the remote ledger records a migration this tree does not have. **Stop**; check out the commit that migration came from |
| smoke fails readiness | the app does not serve. A `503` recorded as *correct handling* still fails readiness, and a redeploy cannot fix a wrong binding or empty data |
| smoke passes | the catalogue and discovery reached the database and the refusals behaved. **Nobody has signed in** |

### Recovering

`docs/OPERATIONS-PILOT.md` §5 has the full table. The two rules that matter most:

- **Do not rerun a step whose effect you have not read back.** Read the ledger, the
  audit rows or the object hash first.
- **A failure before the first write is free.** The verifier, the preflight, the
  conflict check and the receipt check all run before anything changes; a refusal
  there leaves the pilot exactly as it was.

## 6. What a green run still does not prove

- **A person signing in.** Needs an Access identity, a browser, and the Access
  application configured. A `401` from a machine is not proof of a usable login, and
  no workflow here authenticates.
- **A save that survives a reload**, at 390px and 1440px.
- **That the Worker holds the same Access values the deploy passed.** A non-empty
  GitHub secret says nothing about the Worker's secrets; the preflight prints
  `Access configuration matched: NOT CHECKED` for exactly this reason.
- **The founder subject.** The bootstrap takes it as an input and cannot verify it.
- **Anything about money.** No receiving account is configured; QR stays off; payOS
  stays on hold.

## 7. Notes that are easy to forget

- **The backup no longer dies with the runner.** It is stored in a private R2
  bucket, read back and hashed, and a receipt records what was stored. The local
  copy is still deleted at the end of the job.
- **Nothing is uploaded to GitHub.** Artifacts have no per-file access control or
  expiry, so the only artifact anywhere is the browser evidence from `verify.yml`.
- **The receipt is printed and stored** — it holds identifiers, sizes, hashes and
  verdicts, never row contents.
- **The drill is given an explicit `--file`** and replays into a throwaway local
  SQLite. It never restores over pilot.
- **Actions are pinned to commit SHAs**, and the pin must be checked before it is
  used. A 40-hex string is the SHA of *something*; whether that repository has a
  commit by that name is a different question, and the first push of these
  workflows failed in seven seconds on exactly that mistake.
- **`test/workflows.test.ts` enforces the structure**: the verifier holds no secret,
  the execute job checks out only the verified output, every mutating workflow
  shares one lock, no `run:` block interpolates an input, and every shell block
  parses.
