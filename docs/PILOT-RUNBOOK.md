# Pilot runbook

For the person who takes this local build to the private pilot. Every command
here is one that exists in this repository or one of the read-only `wrangler`
commands the repository's own scripts call; nothing is invented. Nothing in this
file has been executed against Cloudflare — read **"What this runbook has not
been tested against"** before trusting a step.

Scope: one Worker (`sadec-flow-pilot`), one remote database (`sadec-pilot`,
binding `sadec_pilot`), behind Cloudflare Access. No public launch, no domain
purchase, no payment integration.

> **Status of this document.** Every command below exists in `scripts/` and was
> run locally against a real SQLite D1 database. Nothing here has been run
> against Cloudflare: the pilot deployment, the Access application and the remote
> migration remain unverified — see the last section.

## 0. What must be true before you start

`docs/PILOT-GATES.md` lists the nine gates this runbook moves, what evidence
exists for each on this commit, and which of them are still `not performed`. Read
it first: it is the checklist you are filling in, and it says plainly that nothing
remote has been run.

Before step 1, you have:

- Cloudflare account access to the account that owns the Worker, the
  D1 database and the Access application. This session did not.
- You have the two values the Worker verifies with, from the dashboard:
  Zero Trust → Access controls → Applications → the pilot application →
  Additional settings: `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (the audience tag).
- You have the Access **subject** of the person who will be the founder — the
  `sub` claim of a verified identity, not their email. Section 6 says where to
  read it; there is no `FOUNDER_EMAIL` setting anywhere any more.
- Decide the escrow question now: **if the pilot will take deposits**, you also
  need `ESCROW_BANK_BIN`, `ESCROW_ACCOUNT_NUMBER`, `ESCROW_ACCOUNT_HOLDER`. With
  none of them the app shows no VietQR and prints a notice saying not to
  transfer; a deposit is still recorded by whoever verified the bank reference.
  That is a valid pilot state, and it is the only one where no money can be sent
  to an account this platform cannot see.
- Know the stop conditions in section 10. They are not advisory.

Never print a secret. When you check for one, check presence, not value:

```bash
test -n "$ACCESS_AUD" && echo "ACCESS_AUD present" || echo "ACCESS_AUD missing"
```

## 1. Identify the targets, before changing anything

Read-only. Confirm the account, then the Worker and database names.

```bash
pnpm exec wrangler whoami
```

Expected: the account you believe you are in. If it is a different account, stop
— every later step would land somewhere else.

The names come from the repository, not from this document:

| Thing | Value | Where it is declared |
| --- | --- | --- |
| Pilot Worker | `sadec-flow-pilot` | `scripts/deploy-preview.ts` (`--name`) |
| Pilot database | `sadec-pilot` | `wrangler.jsonc` (`d1_databases`) |
| D1 binding | `sadec_pilot` | `wrangler.jsonc`; `scripts/require-environment.ts` derives `sadec_<env>` |
| Environment | `pilot` | `APP_ENV` is passed by `deploy-preview.ts` as `APP_ENV:pilot` |

The Worker refuses everything if `APP_ENV` is not `pilot` or the binding is
missing — that is the design, and `deploy-preview.ts` refuses to deploy in that
state rather than shipping a Worker that answers `403` to everyone.

## 2. Check the migration state (read-only)

```bash
pnpm exec wrangler d1 migrations list sadec_pilot --remote
```

Expected before the first migration: `0001`–`0007` all pending, or a subset if a
previous attempt stopped. **Record the output** — it is the before-picture you
will compare against. If it lists a migration this repository does not contain,
stop: the remote schema is ahead of this checkout and a deploy would run code
against a schema nobody here has seen.

## 3. Back up before migrating

```bash
pnpm db:backup -- --env pilot
```

The script prints the target and writes `backups/sadec_pilot-<timestamp>.sql`.
`backups/` is gitignored; the file may contain real pilot data, so treat it as
personal data and do not copy it into the repository, an issue or a chat.

If the database is empty this still produces a file — an empty backup is a valid
restore point, and having one is cheaper than explaining why you skipped it.

## 4. Apply the migrations

```bash
pnpm db:migrate-pilot -- --env pilot --confirm sadec_pilot
```

What the script enforces, rather than trusting you:

- the environment must be exactly `pilot` (`--env demo` or `test` is refused);
- `--confirm sadec_pilot` must match the binding name, so the command cannot be
  run by muscle memory;
- it always passes `--remote`; there is no flag on the local command that reaches
  the pilot database.

`0006` is additive: it adds `config_versions.restored_from_version_id`, backfills
it from `config.rollback` audit rows, and creates a partial unique index. The
index **fails to build** if the database already holds two global versions with
the same number. If the migration stops there, do not delete rows: run the
detection query in the header of `migrations/0006_config_version_lineage.sql` and
decide with a person who knows the data. Nothing was applied, because a
migration that fails leaves the ledger unchanged.

`0007` is also additive: it adds `audit_events.actor_source` with
`NOT NULL DEFAULT 'app'`, a CHECK admitting only `app` and `provisioning`, and an
index on the column. Every audit row that existed before it becomes `app` — the
rows were written by the application or by a migration, and neither is a
provisioning act. Nothing else in any table changes: the local rehearsal on a
populated `0006` database compared all tables before and after and found the
audit column the only difference. **Order matters in one direction only:** this
Worker build never reads `actor_source`, so deploying before or after the
migration both work; a future build that reads the column must not be deployed
before `0007` is applied.

## 5. Set the Worker's configuration, then deploy

The values the Worker reads are exactly the names in `.env.example`. Set them as
secrets/variables on `sadec-flow-pilot` in the Cloudflare dashboard (Worker →
Settings → Variables). This repository has no command for that step, so it is not
scripted here; what it *does* script is the refusal to deploy without them.

Then:

```bash
pnpm build
pnpm deploy:preview -- --env pilot
```

> **Deploying from GitHub instead?** The same command runs inside
> `.github/workflows/deploy-pilot.yml`, dispatched by hand with a full SHA, and the
> whole path — environment, secrets, scopes, order, how to read a failure — is in
> `docs/DEPLOY-VIA-GITHUB.md`. Nothing in it has been run yet.

`deploy:preview` refuses, with a reason, when:

- `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing;
- `dist/sadec_flow/wrangler.json` cannot be read (run `pnpm build` first);
- the generated config has no `sadec_pilot` binding.

That last check exists because the Cloudflare Vite plugin drops the `env` section
when it generates the config the deploy reads. Without it, the deploy succeeds
and the Worker has no database — every route refuses on a build that passed every
local gate.

It no longer asks for `FOUNDER_EMAIL`/`FOUNDER_SUB`, and that is a correction
rather than a relaxation: no code ever read them. The identity that gets
`founder_admin` is an argument to the bootstrap command in step 6, and a deploy
that accepted a founder value without creating a membership taught operators to
expect access they did not have.

## 6. The first membership: `pnpm bootstrap:founder`

A fresh pilot database has no rows, and the application cannot create the first
one: `authorize.ts` resolves a role from a membership that does not exist yet, so
every guarded route answers `403` — including to the founder. §6 forbids the
obvious escapes (first person to log in becomes admin, an email allowlist that
skips the membership check), so the grant is a **provisioning command run by a
person with database access**, outside the Worker and outside HTTP.

Deploying the Worker grants nothing. Configuring Access grants nothing. This is
the step that grants something, and it runs once.

### Where the Access subject comes from

`--access-sub` is the `sub` claim of the identity Cloudflare Access verified — not
an email, and not something you can derive. Two ways to read it, both acceptable:

1. **Access audit log** in the dashboard: the login event shows the identity's
   external identifier.
2. **The application itself**, once the person can sign in anywhere: the decoded
   Access JWT in the browser's `Cf-Access-Jwt-Assertion` cookie carries `sub`.
   Decode it locally; do not paste it into a third-party site.

`test/pilot-bootstrap-gap.test.ts` used to prove the gap; the regression suite is
now `test/founder-bootstrap.test.ts`.

Cloudflare's One-time PIN issuer uses the email as the `sub`. If that is your
provider, the warning the command prints (subject equals email) is expected. If
your provider issues an opaque identifier, an email in that field means you
copied the wrong value — and the identity you create will never be able to sign
in.

### Back up first

```bash
pnpm db:backup -- --env pilot
```

An empty database still produces a file. Take it: it is the only state you can
return to, and a bootstrap is a write.

### Preview, then apply

```bash
# Preview — the default. Writes nothing.
pnpm bootstrap:founder -- --env pilot \
  --workspace-id ws-pilot \
  --workspace-name "Vườn pilot" \
  --access-sub <sub from a verified identity> \
  --email <the same identity's email> \
  --reason "Pilot 2026-11: first founder for the private preview" \
  --operator "<your name or ops handle>" \
  --ticket "<change ticket or chat thread>"
```

`--operator` is required and `--ticket` is optional. Both are written into the
audit row's detail as **declared** values: `operator_reference: "declared"` says
in the row itself that the command cannot authenticate who ran it, and
`subject_attestation: "declared-not-verified"` says `--subject-verified` was an
attestation and nothing more. Put your real name or the on-call handle in
`--operator`; the cross-check is the Cloudflare audit log and your change
ticket, not this string.

The preview prints the current state — whether the workspace, the identity, the
membership and any live founder already exist — and either the four rows it would
write or the exact condition that refuses. Read the refusal; do not work around
it.

```bash
# Apply — the four rows, sent as one SQL file. Same arguments as the preview,
# plus --apply --subject-verified. --operator is required: leaving it out is an
# input error (exit 2), not a quiet default.
pnpm bootstrap:founder -- --env pilot \
  --workspace-id ws-pilot \
  --workspace-name "Vườn pilot" \
  --access-sub <sub> --email <email> \
  --reason "Pilot 2026-11: first founder for the private preview" \
  --operator "<the same name or handle as the preview>" \
  --ticket "<change ticket or chat thread>" \
  --apply --subject-verified
```

`--subject-verified` is an attestation, not a formality: it says you read the
subject from the identity rather than copying the email field.

The command writes one workspace, one identity, one membership (`founder_admin`,
`granted_by` NULL) and one audit row (`membership.granted`, `actor_source`
`provisioning`, `actor_id` NULL) as one SQL file handed to `wrangler d1 execute
--file`. **Locally** that file is one transaction: a probe file whose last
statement violates a CHECK leaves every table empty, and the same file without the
bad statement writes all four rows (`test/bootstrap-transport.test.ts`). The audit
row is written before the membership and gates it. Read the four ids it prints and
keep them in the deployment record.

A successful apply followed by a read-back proves only the **final state**: the
four rows are there. It does not prove that a failure would have left nothing
behind, because no failure happened. Remote atomicity is proved separately, on a
throwaway database, by the procedure in the next section — never by a happy path.

### Proving remote atomicity (on a test D1, never on pilot)

`wrangler d1 execute --file` was proved to be one transaction **on the local
runtime only**. The remote endpoint is a different implementation, so its
behaviour is measured, not assumed. Do this once, before the first pilot
bootstrap, on a **separate D1 database created for this purpose**:

1. Create a throwaway D1 database, for example `sadec-bootstrap-probe`. It must
   hold no pilot data and no customer data, and it must not be the pilot binding.
2. Point the probe at it with synthetic values — a fake subject such as
   `probe-subject-0001`, a fake workspace id, a fake email on
   `example.invalid` — using the **same transport the bootstrap uses**
   (`wrangler d1 execute <probe> --remote --file <file>`), so the measurement is
   about that path and not about a different one.
3. Build a script that writes the same four rows and then, **after** the write
   statements, fails in a controlled way — for example an insert that violates a
   CHECK, or a deliberate duplicate primary key. Ship it and record the exit code
   and the output.
4. Read the probe database back: it must contain **no partial rows** — no
   workspace without its identity, no identity without its membership, no
   provisioning audit row, zero rows in all four tables.
5. Run the same file with the deliberate failure removed. All four rows must
   appear, exactly once.
6. Drop the probe database, or leave it empty and stopped; either way, record what
   was done with it.

If step 4 shows **any** row, remote `--file` execution is not atomic for this
workload. Stop: do not run the pilot bootstrap, and treat the pilot grant as
something that can leave a half-written state. That is a finding to report, not a
step to retry.

**Never run the failing variant against the pilot database or any database holding
customer data**, and never run it against the database that is about to receive
the founder — the probe exists so a controlled failure costs nothing.

As of this writing the probe has **not** been run against a remote database. The
local result is in `test/bootstrap-transport.test.ts`; the remote column of the
gate sheet (`docs/PILOT-GATES.md`) stays `not performed` until someone runs the
steps above and pastes the output.

### What it refuses, and why it will not "just fix" it

| Situation | Result |
| --- | --- |
| Same subject, workspace and role already active | `ALREADY` — nothing written, no second audit row |
| Membership was revoked | refused (`membership_revoked`) — bootstrap does not restore access |
| Subject holds another role there | refused (`role_conflict`) — never upgrades a role |
| Workspace id exists under another name | refused (`workspace_name_conflict`) |
| A live founder already exists | refused (`founder_exists`) |
| The email belongs to a different subject | refused (`email_owned_by_another_subject`) |
| Two applies at once | one creates; the other writes nothing — see the exit codes below |

Bootstrap is not a membership manager and not an account-recovery tool. Every
refusal above is a decision for a person, made in the application.

### Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Applied, or `ALREADY` (nothing written) | Read the ids it printed |
| 2 | Invalid or incomplete input, or a guard refused | Fix the input; nothing ran |
| 3 | Refused by policy (`founder_exists`, `membership_revoked`, …) | A person decides; do not retry |
| 4 | Read phase failed, so nothing was written | Wait, run the preview again |
| 1 | The write itself failed, or the state is inconsistent | Run the preview and read the rows: it cannot tell you whether the batch landed |

Exit 4 and exit 1 are different claims, and the difference matters: 4 says the
command never got far enough to write, 1 says the write failed and the command
cannot prove what happened. Neither is a reason to retry blindly.

### If the apply exits 1: the outcome is unknown, not failed

Exit 1 can happen **after the request has already reached D1**. The rows may be
there, may be absent, or — the case this whole page is about — may be half there.
Do not guess, and do not "run it again to see".

1. **Do not conclude that the bootstrap did not run.** Exit 1 is not evidence of
   that. It says only that the process cannot tell what landed.
2. **Do not change the subject, the workspace id, the email or any other input
   and apply again.** A second, different intention writes a second set of rows
   and destroys the ability to tell which one is the real grant.
3. **Read the state back** with the queries below. They are read-only.
4. **Compare content and relations, not row counts.** A count of four can hide a
   membership pointing at the wrong identity, or an audit row naming a membership
   that does not exist. The three queries answer: is the grant complete, is the
   audit row the one that gated it, and is anything orphaned?
5. **If all of it is present and consistent**, record the grant as done, keep the
   ids, and move on. The exit code was noise; the rows are the truth.
6. **If none of it is present**, the batch wrote nothing. Check the connection and
   the credentials (`pnpm exec wrangler whoami`), then — and only then — retry the
   **same** intention, with the same subject, workspace and inputs.
7. **If the state is partial or contradictory** — a workspace with no identity, a
   membership whose `subject_id` names nothing, a provisioning audit row with no
   membership — **stop**. Do not delete or repair rows by hand to make a re-run
   succeed. That is exactly the half-written state the probe in the previous
   section exists to detect; record what you see, take a backup, and investigate
   before any further write.

The three read-only queries, for `<sub>` and `ws-pilot` substituted:

```bash
# A. The grant as a whole. Expect exactly one row: founder_admin, revoked_at NULL,
#    and the subject that Access will issue.
pnpm exec wrangler d1 execute sadec_pilot --remote --json --command \
  "SELECT w.id AS workspace, w.name AS workspace_name,
          i.access_sub, i.email,
          m.id AS membership, m.role, m.granted_by, m.granted_at, m.revoked_at
     FROM memberships m
     JOIN workspaces w ON w.id = m.workspace_id
     JOIN identities i ON i.id = m.identity_id
    WHERE w.id = 'ws-pilot'"

# B. The audit row that gated it, with the declared operator read out of the JSON.
#    Expect one row whose subject_id IS the membership id from A, actor_source
#    'provisioning', actor_id NULL, operator_reference 'declared'.
pnpm exec wrangler d1 execute sadec_pilot --remote --json --command \
  "SELECT a.id, a.action, a.actor_source, a.actor_id,
          a.subject_type, a.subject_id,
          json_extract(a.detail,'$.operator')            AS operator,
          json_extract(a.detail,'$.operator_reference')  AS operator_reference,
          json_extract(a.detail,'$.ticket')              AS ticket,
          json_extract(a.detail,'$.subject_attestation') AS attestation,
          a.created_at
     FROM audit_events a
    WHERE a.workspace_id = 'ws-pilot'
      AND a.action = 'membership.granted'
      AND a.actor_source = 'provisioning'
    ORDER BY a.created_at DESC"

# C. Orphans, in both directions. Both queries must return no rows.
pnpm exec wrangler d1 execute sadec_pilot --remote --json --command \
  "SELECT a.id AS audit_without_membership
     FROM audit_events a
    WHERE a.action = 'membership.granted' AND a.actor_source = 'provisioning'
      AND NOT EXISTS (
        SELECT 1 FROM memberships m
         WHERE m.id = a.subject_id AND m.workspace_id = a.workspace_id
           AND m.revoked_at IS NULL)"

pnpm exec wrangler d1 execute sadec_pilot --remote --json --command \
  "SELECT m.id AS membership_without_audit
     FROM memberships m
    WHERE m.role = 'founder_admin'
      AND NOT EXISTS (
        SELECT 1 FROM audit_events a
         WHERE a.action = 'membership.granted'
           AND a.subject_type = 'membership' AND a.subject_id = m.id)"
```

Reading them together is the point: A says a grant exists, B says what was
recorded about it, C says nothing is dangling. Two out of three is not a completed
bootstrap.

There is no `--status` flag, and none is being added — a status mode is the first
half of a membership-management surface this command deliberately is not. The
three queries above, and the preview (`pnpm bootstrap:founder` without `--apply`,
which reads and prints the same state), are the whole read path. `docs/PILOT-GATES.md`
row 7 stays `not performed` until a real apply has been read back this way.

**Two concurrent runs are not a supported way to operate**, but they are safe in
the one way that matters: a local rehearsal (2026-10-30) ran two `--apply`
processes against the same database five times and never produced two founders
or a partial set of rows. The loser exited 3 (policy), 4 (could not read) or 1
(the write failed) depending on where the two processes collided — a property of
two `wrangler` processes sharing one SQLite file, not of the command.

### Check it

Run queries **A**, **B** and **C** from "If the apply exits 1" above. They are the
same three whether the apply exited 0 or 1, because the question is the same
question: are the rows there, does the audit row gate the membership, and is
anything dangling?

Expected: exactly one `founder_admin` with `revoked_at` NULL, one `provisioning`
audit row whose `subject_id` is that membership, `granted_by` and `actor_id` NULL,
and no rows from either orphan query. Then sign in through Access **as that identity** and confirm
`/api/session` reports `role: "founder_admin"` with the workspace listed. A `403`
here means the subject in the database is not the subject Access issued — compare
them character by character; the `warning` the command prints when subject equals
email is the usual cause of a wrong one.

### If you granted the wrong membership

Do not delete the row and do not delete the audit event: the history is the
record of what happened, including the mistake. Revoke instead:

```bash
# 1. Look first. Copy the membership id from the output.
pnpm exec wrangler d1 execute sadec_pilot --remote --json --command \
  "SELECT id, identity_id, workspace_id, role, granted_at, revoked_at FROM memberships"

# 2. Revoke, keeping the row and writing the audit event that explains it.
#    Both statements go in one file so they commit together.
cat > /tmp/revoke.sql <<'SQL'
UPDATE memberships
   SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = '<membership id>' AND revoked_at IS NULL;

INSERT INTO audit_events
       (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at, actor_source)
SELECT 'ae-revoke-<membership id>', m.workspace_id, NULL,
       'membership.revoked', 'membership', m.id,
       'Revoked by operator after a mistaken bootstrap grant: <what went wrong>',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'provisioning'
  FROM memberships m
 WHERE m.id = '<membership id>' AND m.revoked_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.id = 'ae-revoke-<membership id>');
SQL

pnpm exec wrangler d1 execute sadec_pilot --remote --file /tmp/revoke.sql
rm /tmp/revoke.sql
```

There is no `--revoke` flag and there should not be: revocation is a decision
taken in the application when the application can run, and a provisioning script
that also revokes would be a membership manager with its own authorization
rules. Until the app can revoke (it cannot yet — `membership.revoke` is declared
in the permission table with no route behind it), this statement is the honest
way to undo a mistake without erasing it.

After revoking, the founder's next request is refused — the chokepoint reads the
membership on every request, so there is no session to wait out.

## 7. Smoke tests, in this order

Replace the host with the deployed Worker's URL. Each line has an expected result
and each expected result is a statement about the product, not a formality.

### First, the half that can be one command

```bash
pnpm smoke:live -- --base-url https://<pilot-host> --expect-env pilot
```

(`--expect-env` is required: the run refuses to proceed without knowing which
environment it is meant to be checking, and refuses a target of the wrong kind —
`pilot` on a loopback host, or `local` on a remote one. The same check runs as
`.github/workflows/smoke-pilot.yml`.)

It asks the unauthenticated questions below — health and the environment it
reports, the catalogue's unavailable-versus-empty answer, the schema, the
discovery page, a missing credential, a forged token, the development identity,
a guarded read and a guarded write, and whether the public projection leaks a
private field — and **exits non-zero** when one is wrong, so the result is a
status rather than a paragraph somebody has to interpret. It sends no credential
and writes nothing.

Two things about it that are deliberate. A `localhost` target is refused unless
`--local` is passed, and a local run prints that it is a developer check, because
the easiest way to get this wrong is to paste a green localhost run into a
release note. And when the Worker reports `env` of `local`, `test` or
`development`, the identity checks are reported as skipped with that reason: in
those environments the labelled demo identity signs in by design, so a `401`
there would mean something different. On a deployment, an `env` that is not
`pilot` or `demo` is itself a failure, which is what stops the skip from becoming
a hole.

**A green run is not evidence that the pilot is usable.** It proves the public
surface answers and the gates are closed. Signing in, saving through the UI and
the business flows are the section below, done by a person.

### By hand, for the record

Each line has an expected result and each expected result is a statement about
the product, not a formality.

```bash
# 1. The Worker is alive.
curl -sS -o /dev/null -w '%{http_code}\n' https://<pilot-host>/api/health
# expect 200

# 2. The public catalogue answers. Two acceptable answers, and they mean different things:
curl -sS -i https://<pilot-host>/api/public/catalog | head -20
#  200 + {"lots": [...]}                    → lots are published
#  200 + {"lots": []}                       → nothing is published (a real answer)
#  503 + {"code":"catalog_unavailable"}     → the database could not be read
# Anything else, especially 200 with an error body, is a bug.

# 3. The machine-readable surface.
curl -sS -o /dev/null -w '%{http_code}\n' https://<pilot-host>/llms.txt
# expect 200 (it describes the service, and reads no data)
curl -sS -o /dev/null -w '%{http_code}\n' https://<pilot-host>/llms-full.txt
# expect 200 with lots, 200 with the "chưa có lô" sentence, or 503 — never 200 claiming empty when the read failed
```

### Access and identity

```bash
# 4. No token: refused.
curl -sS -o /dev/null -w '%{http_code}\n' https://<pilot-host>/api/session
# expect 401

# 5. A forged assertion: refused. The value does not matter; the refusal does.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Cf-Access-Jwt-Assertion: forged.token.value' \
  https://<pilot-host>/api/session
# expect 401

# 6. The dev-identity probe must not exist on a deployment.
curl -sS -o /dev/null -w '%{http_code}\n' https://<pilot-host>/api/whoami
# expect 404
```

A `200` on any of 4–6 is a **stop condition**: it means identity is not being
verified, or a local-only path reached a deployment.

### Through the browser, as the founder

Sign in through Access as the identity you provisioned in section 6, then:

1. `/api/session` in the browser returns `role: "founder_admin"` and a
   `workspaces` list. If the role is not `founder_admin`, the bootstrap did not
   match the identity you signed in with — fix the configuration, do not add a
   membership by hand to move on.
2. The founder area loads interviews, configuration and the OPC ledger.
3. Switch workspace in the header, if more than one is listed. Expected: the
   badge changes only after the server confirms, and a workspace you were removed
   from is not offered.

### Role and workspace boundaries

Once the founder exists (step 6), check the boundary from a second browser
profile:

- an operator opening `/api/founder/config` gets `403`;
- an operator confirming a deposit gets `403` with a reason;
- revoking a membership and reloading: the **next** request is refused, without
  waiting for a session to expire;
- asking for a workspace the identity does not hold answers `403` and never
  returns that workspace's rows.

### Money, and what is not money

- With `ESCROW_*` unset: a booking page shows no QR and says not to transfer.
  `/api/b2b/bookings` returns `deposit_vietqr: null` and `balance_vietqr: null`.
- Recording an inspection produces obligations: the booking moves to an inspected
  state and `b2b_settlements` holds `AWAITING_BALANCE` or `READY_TO_RELEASE`.
  **No money has moved.** The escrow ledger must still show only the deposit the
  founder confirmed, with the reference they typed.
- Confirming the settlement is what writes ledger rows. Read them back: deposit +
  balance collected, payout, refund, fee. A VietQR payload, a bank reference and
  a computed balance are not proof of a bank credit; the ledger records a person's
  confirmation.

## 8. What to record

For each step: the command, the timestamp, the output you actually saw. In
particular record the migration list before and after, the smoke-test status
codes, and one screenshot of the founder area with the DEMO banner absent (a
pilot that shows the demo label is reading the wrong environment).

Write the results into `docs/RELEASE.md` under a dated heading, labelled as
**live**. This file's own verification column says which claims are local.

## 9. Branch protection (repository setting, not a deploy step)

GitHub creates a check named after the workflow and the job:
`.github/workflows/verify.yml` has `name: verify` and one job `verify`, so the
check appears as **`verify / verify`**. Enable "Require status checks to pass"
on `main` and select that check **after** a run of the workflow has been observed
to pass on this branch.

Unverified: no run of this workflow exists yet, so the exact check name is
inferred from the file and the repository setting could not be read or changed
from here. If the check name differs when the first run appears, use the name
GitHub lists — not this paragraph.

## 10. Stop conditions

Stop, and do not continue with the next step, if any of these happens:

1. `wrangler whoami` shows an account you did not expect.
2. `migrations list` reports a migration this checkout does not contain.
3. `db:migrate-pilot` exits non-zero. Do not re-run it blindly; the failure text
   names the statement.
4. Any smoke test returns a status outside its expected set above.
5. A request that should be refused (401 for 4–5, 404 for 6) returns `200`.
6. A role or workspace check returns rows the identity should not hold.
7. The founder area shows the DEMO banner, or `/api/session` reports
   `demo: true`, on the pilot host.
8. The public catalogue returns `200` with `lots: []` **while** `/api/health`
   reports an environment other than `pilot` — that combination means the Worker
   is reading a database it was not supposed to.
9. The founder cannot reach `/api/session` with `200` *after* a successful
   bootstrap. That is not a missing step: it means the subject in the database is
   not the subject Access issued, or the membership is revoked. Compare the two
   subjects; do not widen a role or edit the row to make it pass.
10. The bootstrap exited 1 **and** queries A–C show a partial or contradictory
    state — a workspace with no identity, an audit row with no membership, a
    membership nothing gated. Stop and investigate; do not repair rows by hand to
    make a re-run work.
11. The remote atomicity probe (previous section) left any row behind after its
    deliberate failure. That is a negative result about the transport, not about
    the pilot. Do not bootstrap the pilot until it is understood.

## 11. Recovery, and its limits

- **Worker code.** A Worker deploy is versioned; rolling back is a Cloudflare
  action on the Worker's previous version. Nothing in this repository automates
  it, so record the version id the deploy prints *before* you change anything.
- **Data.** Migrations here are forward-only. There is no down-migration and no
  script that restores a backup onto the pilot database: `pnpm db:restore:test`
  accepts only `--env test` and lands in `sadec-test-restore`, deliberately,
  because a restore pointed at the wrong database destroys what it lands on.
  Restoring pilot data is a manual D1 import from the file taken in step 3, and
  that is a decision for whoever owns the data — not a step this runbook performs.
- **A migration that failed halfway.** The ledger row is not written, so the
  database is at the previous migration. Fix the cause, re-run. Do not edit an
  applied migration file: add the next numbered one.
- **A deploy that produced refusals on every route.** Check, in order:
  `APP_ENV` reached the Worker (`deploy-preview.ts` passes `APP_ENV:pilot`), the
  `sadec_pilot` binding is in the deployed config, and the three Access values are
  set. Each of those failures looks identical from outside — a `403` for everyone.

## 12. Rehearse this locally first (a full drill, no remote)

Every step below was executed on 2026-10-30 on a scratch clone — no `.git`, no
`node_modules` from the developer tree, its own `.wrangler/` directory — and the
recorded results are in `docs/CHECKPOINT.md` §"Local release-candidate
rehearsal". Repeat it on any machine before trusting this document:

```bash
# 0. A clone that cannot touch the developer database or the pilot one.
tar -c --exclude=.git --exclude=node_modules --exclude=.wrangler \
  --exclude=dist --exclude=backups . | tar -x -C /tmp/drill-src
cd /tmp/drill-src && corepack pnpm install --frozen-lockfile

# 1. Schema up to the migration *before* the one under test, then representative
#    data. `pnpm db:seed:demo` refuses --env test on purpose; the drill has its
#    own dataset with two workspaces, an accepted quote revision, an order, a
#    confirmed receipt, a held deposit, config lineage and pre-migration audits.
pnpm db:migrate:local -- --env test           # with 0007 parked elsewhere
pnpm exec wrangler d1 execute sadec_test --local \
  --file scripts/fixtures/release-drill-dataset.sql

# 2. Back up, then migrate forward, then read the counts back.
pnpm db:backup -- --env test
pnpm db:migrate:local -- --env test

# 3. Preview, apply, then apply the same subject again.
pnpm bootstrap:founder -- --env test --workspace-id ws-drill-founder \
  --workspace-name "Sadec Drill Founder" --access-sub drill-founder-sub-0001 \
  --email founder+drill@example.test --reason "local restore drill" \
  --operator "ops:drill-runner" --ticket "DRILL-0001"
pnpm bootstrap:founder … --apply --subject-verified

# 4. Restore the backup into the separate restore database and read it back.
pnpm db:restore:test -- --env test
```

What correct looks like: the preview prints `Nothing was written` and changes no
count; the apply adds exactly one workspace, one identity, one membership and one
`provisioning` audit row; the second apply prints `already holds a live
founder_admin` and adds nothing; the restore reads back the ten tables at the
values the backup was taken with. A restore that reports counts you cannot
explain is a failed drill, not a rounding error.

**Do not "simplify" this by pointing it at the pilot database.** The value of the
drill is that being wrong costs nothing.

## What this runbook has not been tested against

Nothing below was executed from this repository, and each one is a real gap
rather than a formality:

- the live Worker and its URL;
- Cloudflare Access behaviour on that host (the token used in development has D1
  write but not the Access permission, so the application could not be created or
  inspected);
- a remote migration through `0007`;
- any payment leg — there is no receiving account configured and no bank
  integration by design;
- `pnpm bootstrap:founder` against a remote database — it was run against a local
  one, through the same `wrangler d1 execute` transport, and the file it generates
  was executed locally;
- **atomic rollback of a `--file` script on the remote D1 endpoint.** The local
  runtime was measured (`test/bootstrap-transport.test.ts`); the remote endpoint
  was not. The procedure is written above and has not been executed against any
  remote database — not on pilot, and not on the throwaway probe either;
- the exact name of the CI status check, until the workflow runs once;
- a second, unrelated identity being provisioned — the command refuses a second
  founder, and granting one through the application has no route yet.
