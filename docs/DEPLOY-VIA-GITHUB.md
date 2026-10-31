# Deploying from GitHub, by hand

This is the operator's checklist for the deployment path introduced in round 17:
GitHub Actions runs the deploy, and the owner enters the credentials. Nothing here
has been run yet — **no workflow in this repository has ever been dispatched, no
deploy or migration has been performed by one, and no GitHub Environment exists
yet**. It is preparation, and this file describes what to do once you have
configured it.

Read `docs/PILOT-RUNBOOK.md` for the product-level run, `docs/CHECKPOINT.md` for
what is actually true today, and `docs/RELEASE.md` for what was deployed and when.

---

## Why this exists

Deploying from the assistant's sandbox was blocked twice, for two different
reasons that both point the same way:

- the sandbox had no Cloudflare credential, and buying, upgrading or creating a
  paid resource on the owner's behalf is not something it may do;
- Cloudflare was unreachable from it at the transport layer
  (`SSL_ERROR_SYSCALL`) while GitHub answered normally.

GitHub Actions solves both: it is reachable, it is where CI already runs, it holds
the repository's own secrets, and it produces an auditable run per deploy. The
sandbox's job is now code, tests, the pull request and CI — not the deployment.

**Nobody types a secret into a chat, an issue, a pull request or a file in this
repository.** The owner enters them on GitHub, once, in the environment described
below.

---

## 1. What to create on GitHub, in order

Do this before dispatching anything. A workflow that names an environment GitHub
has never seen **creates it with no protection rules**, which quietly means no
approval and no scope — so create it yourself first.

1. **Settings → Environments → New environment → `pilot`.**
   - Add yourself under **Required reviewers** if your plan offers it. On a
     private repository this may be a paid-plan feature; if the controls are
     missing, the run will still work but with no approval gate, and that must be
     recorded rather than assumed. (Verified state today: this account has **zero
     environments**, so whether approval is available here is **unverified**.)
   - Leave *Deployment branches* restricted to `main` if the control exists.
2. **Add the environment secrets** (Settings → Environments → `pilot` → Secrets →
   *Add secret*). Names must be exact; a typo reads as an empty value:

   | Name | What it is | Where it comes from |
   | --- | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | API token, scopes below | Cloudflare dashboard → My Profile → API Tokens |
   | `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` | Zero Trust → Settings → Custom Pages / the Access application |
   | `ACCESS_AUD` | the Access application's audience tag | Zero Trust → Access → Applications → *your app* → Additional settings |

   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are **also Worker secrets**. A workflow
   cannot set a Worker secret without putting the value on a command line, so do
   that once by hand from a machine you control:

   ```
   pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN --name sadec-flow-pilot
   pnpm exec wrangler secret put ACCESS_AUD          --name sadec-flow-pilot
   ```
   (`wrangler secret list --name sadec-flow-pilot` prints the *names* only, which
   is the safe way to check they exist.)

3. **Add the environment variable** (same environment, *Variables* tab):

   | Name | Value | Why a variable and not a secret |
   | --- | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | `f691e83094f776311a1bfe3f8b126f1c` | not a credential; it is on the dashboard URL, and the preflight compares it |

4. **No repository-level secrets.** Every workflow here declares
   `environment: pilot`, so the values above are only readable by a job that
   declares that environment. A repository secret would be readable by any
   workflow, which is exactly the exposure the split avoids.

### There is no demo environment, on purpose

The demo Worker (`sadec-flow`) exists from an earlier deployment, but this
repository has **no `deploy:demo` command, no guarded remote-migration path for
the demo database, and no demo Access configuration**. Adding one from a workflow
would be a new, unguarded write path — exactly what these guards exist to prevent.
Demo deployment is therefore out of scope until a round adds the commands and the
guard entries with the same rigour as `deploy:preview` and `db:migrate-pilot`.
Everything below is `pilot`.

---

## 2. Cloudflare permissions, per operation

Create **one** token for the whole pilot path, or per-operation tokens if you
prefer narrower ones. Minimum scopes:

| Operation | Workflow | Token scopes |
| --- | --- | --- |
| Read the account, the D1 database, the Worker | `ops-preflight-pilot` | Account: Read, D1: Read, Workers Scripts: Read |
| Export the database | `db-backup-pilot` | the above + D1: Edit |
| List/apply migrations, bootstrap the founder | `db-migrate-pilot`, `bootstrap-founder-pilot` | the above + D1: Edit |
| Upload the Worker | `deploy-pilot` | the above + Workers Scripts: Edit |
| Smoke test | `smoke-pilot` | **none** — it holds no secret at all |

An `Access: Edit` scope is **not** used by any workflow: the Access application is
created in the dashboard, and nothing here changes it. If you want the token to be
able to read Access settings too, add Access: Read — but no step requires it.

The token is scoped to the account above. A token from another account is what the
preflight exists to catch.

---

## 3. The six paths, in the order to run them

Each is a separate `workflow_dispatch`. None runs on a push, none runs on a PR,
and none of them deploys both targets — the pilot workflows can only reach the
`pilot` environment.

| # | Workflow | Writes? | Run it when |
| --- | --- | --- | --- |
| 1 | `ops-preflight-pilot` | no | first, and after any credential or account change |
| 2 | `db-backup-pilot` | reads D1, writes a local file | before step 3, always |
| 3 | `db-migrate-pilot` | yes — schema | only with a green step 2 |
| 4 | `deploy-pilot` | yes — Worker upload | after step 1, and after step 3 if the schema moved |
| 5 | `smoke-pilot` | no | after step 4 |
| 6 | `bootstrap-founder-pilot` | yes — one membership | **once**, after a human has a verified Access subject |

### Choosing the commit

Every workflow asks for one input: `sha`.

- Use a **full 40-character SHA** of a commit that is already on `main`.
- The job refuses a branch name, a tag, a short SHA, a commit that is not on
  `main`, and a commit with no **completed, successful** `verify` run of its own
  (`pnpm require-main-sha`). It then checks that exact commit out — not
  `github.sha`, which is the branch tip and may be a later, unproved tree.
- Find the SHA: the merge commit of the pull request that changed the code, or
  `git log --oneline origin/main | head`. The gate run for it is on the repository's
  Actions page, workflow `verify`.

### Running one

Actions → the workflow name → **Run workflow** → branch `main` → fill the inputs →
**Run workflow**.

For `deploy-pilot`, `db-migrate-pilot` and `bootstrap-founder-pilot` there is a
second input, `confirm`, which must be exactly `sadec_pilot`. It is a deliberate
pause on the irreversible steps, and it is a literal in the workflow — not
something an input can change.

---

## 4. Reading results, and what each one means

| What you see | What it means |
| --- | --- |
| `pnpm require-main-sha` refuses | the SHA is not on `main`, or has no successful `verify` run. Nothing ran. Pick the merge commit of a merged PR. |
| `preflight` FAIL on `account id` | the token belongs to another account, or `CLOUDFLARE_ACCOUNT_ID` is unset. Nothing was written. |
| `preflight` FAIL on `database sadec-pilot` | no visible database with that name, or its id is not the id `wrangler.jsonc` binds. **Do not "fix" the config to match** — find out which of the two is wrong first. |
| `preflight` FAIL on `Access configuration` | one of the two Access values is empty in the environment secrets. The deploy would produce a Worker that refuses everyone. |
| `preflight` INFO on the worker | the Worker does not exist yet (first deploy) or its presence could not be confirmed. Information, not a refusal. |
| `Conflict check` fails with `CONFLICT` | the remote ledger records a migration whose file this tree does not have. An applied migration was edited or removed, or the wrong tree is being deployed. **Stop.** Check out the commit that migration came from. |
| `Pending — …` list | exactly what the migration is about to run. Read it. |
| `Read back` fails | the migration reported success but the ledger does not agree. Stop and read the ledger by hand; do not rerun blind. |
| `Prove the export replays` fails | the backup is not restorable. **Do not migrate.** A backup that fails its drill is not a backup. |
| `smoke-pilot` FAILs readiness | the deployment is not serving. Check the `503` note: it is recorded separately as *correct handling*, and readiness still fails — a well-formed error is not a working database. |
| `smoke-pilot` PASSes | the catalogue and discovery pages reached the database, and the refusals behaved. **It does not mean a person can sign in.** |

### Nothing succeeded — how to recover

- **Preflight or the SHA guard refused:** nothing was written. Fix the input or the
  credential and run the same workflow again.
- **Migration conflict:** stop. Do not apply anything. Read the ledger by hand with
  `wrangler d1 execute sadec_pilot --remote --command "SELECT name FROM d1_migrations ORDER BY id"`,
  and restore the migration file from the commit that introduced it.
- **Backup drill failed:** the export is unusable. Take a new backup; if that also
  fails its drill, do not migrate and do not deploy schema-dependent code.
- **Deploy failed after upload started:** Cloudflare either kept the previous
  version or the new one. Confirm with `wrangler deployments list --name sadec-flow-pilot`
  from a machine you control, then decide: redeploy the previous SHA (it still has
  to pass the same guards) rather than hand-editing anything.
- **Smoke failed:** do not redeploy as a reflex. Read the failure. If the Worker is
  serving `503 catalog_unavailable`, the database binding is wrong or the database
  is empty — a redeploy cannot fix either.
- **Bootstrap wrote the wrong subject:** this is the one step that needs a human
  decision, not a script. Read the rows back, and follow
  `docs/PILOT-RUNBOOK.md` §bootstrap; do not patch the database to make the UI look
  right.

### Stopping a run

Cancel it in the Actions UI. `cancel-in-progress` is `false` on purpose: a
cancelled deploy or migration may have half-written, and the state you must reason
about afterwards is worse than waiting. Prefer letting a step fail on its own guard.

---

## 5. What a green run still does not prove

These remain **human gates**, and no workflow here substitutes for them. See
`docs/PILOT-GATES.md` for the full list.

- **A person signing in.** Needs an Access identity, a browser, and the Access
  application configured. A `401` from a machine is not proof of a usable login.
- **A save that survives a reload** — the business flow, in a browser, at 390px and
  1440px.
- **Access policies on the Worker hostname** — created in the dashboard, not by a
  workflow.
- **The founder grant**: the subject must come from a verified identity. The
  workflow takes it as an input and cannot verify it.
- **Payments.** There is no configured receiving account; QR stays off until the
  owner names one. payOS stays on hold: no integration, no fee guessed, no transfer.

---

## 6. Notes that are easy to forget

- **The backup never becomes an artifact.** A pilot export holds real business
  records and GitHub artifacts have no per-file access control. `db-backup-pilot`
  takes the export, drills it, and deletes it from the runner. If you need an
  archive, run `pnpm db:backup -- --env pilot` from a machine you control and store
  it where pilot data belongs.
- **The drill is given an explicit file** (`--file`), and it replays into a
  throwaway local SQLite database. It never restores over pilot, and it refuses to
  guess the newest backup.
- **Actions are pinned by commit SHA**, not by `@v4`; `test/workflows.test.ts`
  fails on a tag. Permissions are `contents: read` plus `actions: read` — nothing
  here can write to the repository.
- **Updating a pinned action means checking the SHA exists first.** A 40-hex
  string is a SHA of *something*; whether `actions/setup-node` has a commit by that
  name is a different question. The first push of these workflows failed in seven
  seconds on exactly that: a setup-node SHA taken from an index rather than from the
  repository, and `Unable to resolve action`. Verify before committing:

  ```
  gh api repos/actions/setup-node/commits/<sha> --jq .sha
  gh api repos/actions/setup-node/commits/v4   --jq .sha   # what v4 points at today
  ```

  The four in use here are `checkout` `11d5960a…f677262`, `setup-node`
  `49933ea5…6820020`, `upload-artifact` `ea165f8d…607fa02` (all `v4`), and each was
  read back from the API above.
- **No workflow prints the environment, enables shell tracing, or uploads a file
  that could hold a secret.** That is enforced by the same test.
- **`pnpm verify` on the same SHA is the gate that must be green first.** The
  deploy workflow re-checks that fact rather than trusting the person who typed
  the SHA.
