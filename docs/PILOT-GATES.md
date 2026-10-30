# Pilot gates: what is proved, and what is not

A gate is a question about the real deployment that a local run cannot answer. This
file lists each gate once, with the evidence that exists for it **on this commit**
and a status that says what the evidence is worth. Nothing here is a forecast of a
remote result: a remote gate is `not performed` until someone runs it and pastes
the output, and an expected result is never written as PASS.

Two facts belong at the top, because every row depends on them:

- **The release candidate is the commit the handover bundle was cut from.** Its
  full SHA is in `sadec-flow-handover.manifest.md`, beside the bundle and outside
  it, because a SHA written into a tracked file goes stale the moment a commit is
  added. The branch is `arena/6a7d60c9-sadec-opc-webapp`.
- **The highest migration in this tree is `0007_audit_provisioning_actor.sql`.**
  The pilot database has never been touched by this session.

| # | Gate | Status | Evidence, and where it lives |
| --- | --- | --- | --- |
| 1 | **Source** — one commit identifies code, bundle and test results | local only | One commit on the branch above; the bundle is cut from it, cloned, and the clone's `HEAD` compared. See the manifest for SHA and SHA-256. Untracked working-tree edits would break this, which is why the bundle is cut after `git status` is clean. |
| 2 | **CI** — a successful GitHub run on that SHA | **not performed** | `.github/workflows/verify.yml` exists, and `test/deploy-config.test.ts` asserts its content. It has never run: no run, no check name, no duration was observed. Do not cite a check name as if seen. |
| 3 | **Target** — account, Worker and D1 confirmed by a person | **not performed** | `docs/RELEASE.md` records demo and pilot Workers deployed at remote schema `0004` **as release notes from an earlier session**; this session re-deployed nothing and verified no live URL. The operator confirms the account, the Worker version and the D1 binding in `docs/PILOT-RUNBOOK.md` §1 before anything is written. |
| 4 | **Backup** — an artefact exists *and* a restore of it was rehearsed | local PASS, remote **not performed** | Local drill 2026-10-30: `pnpm db:backup -- --env test` produced a 32-insert file; `pnpm db:restore:test` restored it into `sadec_test_restore` and read back ten tables, `PRAGMA foreign_key_check` empty, money and lineage identical. A pilot backup has not been taken. |
| 5 | **Migration** — target schema state, and the result of applying | local PASS, remote **not performed** | `0007` on an empty database and over a populated `0006` database (`test/migration-0007.test.ts`, `test/migration-0007` inside the drill): old rows become `app`, new `provisioning` rows accepted, invalid values rejected by CHECK, every other table unchanged. The pilot database is not at `0007`; the runbook's step 2 records whatever it *is* at. |
| 6 | **Access** — a real token accepted, a forged one rejected | local only, live **not performed** | `test/worker-auth.test.ts` and `test/verify-access-token.test.ts` cover real/forged/absent tokens and the fail-closed path. No `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` exists in this workspace, and the token available here has D1 write but not Access scope, so no Access application was created or inspected. |
| 7 | **Bootstrap** — preview correct, exactly one apply, complete audit row | local PASS, remote **not performed** | Preview printed `Nothing was written` and changed no count; the apply added one workspace, one identity, one membership and one `provisioning` audit row with `operator`, `operator_reference: "declared"`, `ticket` and `subject_attestation: "declared-not-verified"`; a second apply said `already holds a live founder_admin` and added nothing. Remote behaviour of `wrangler d1 execute --file` as one transaction is **unobserved**, and a successful apply cannot show it — that needs the throwaway-D1 probe in `docs/PILOT-RUNBOOK.md` §6, which has not been run. |
| 8 | **Authorization** — the right founder and workspace, another identity refused | local PASS, live **not performed** | The membership row reads back `founder_admin` with `revoked_at` NULL against the intended subject, and `integration`/unit tests cover another identity being refused (`test/authorize.test.ts`, `test/tenant-boundary.test.ts`). Nobody has signed in through Access as that identity, so `/api/session` has not been seen to report the role. |
| 9 | **Money** — no QR when unconfigured, and the ledger never fakes a receipt | local PASS, live **not performed** | `test/vietqr.test.ts` and `test/escrow-ledger.test.ts`: with no `ESCROW_*` values a booking renders no QR and says so; a receipt is recorded only against a reference a founder verified; the ledger's totals come from receipts, not from a deposited flag. No bank account is configured and no payment leg has run. |

## Permissions a person needs before the remote gates can move

Local scope, which is what this session had: read, edit, test, prepare migrations,
workflow and docs for review. Everything below is somebody else's to hold.

| Task | Cloudflare permission | Who |
| --- | --- | --- |
| Read the target and its migration ledger | Workers Scripts: Read, D1: Read | pilot operator |
| Take the pre-change backup and keep it | D1: Read (export) + custody of the file | **the project owner**, because the file contains real data |
| Apply migrations to the pilot database | D1: Edit | whoever the owner names accountable for database rights — one person, named before the run |
| Deploy the Worker | Workers Scripts: Edit | release engineer |
| Create or inspect the Access application | Zero Trust / Access: Apps and Policies Edit | account owner |
| Run the bootstrap | **no Cloudflare permission of its own** — it is a local `wrangler d1 execute` with D1 write | whoever holds D1: Edit; the audit row records the operator they declare |
| Confirm the operator identity and the subject | none in Cloudflare; it is an attestation | the project owner signs off in the change ticket |

The project owner must confirm they hold and will retain these before the first
remote step; nobody on this side of the handover can grant them, and this document
does not assume they exist.

## Stop conditions

Stop the pilot run, take no further write, and record what happened if:

1. The backup file was not produced, or a rehearsal of restoring it has not been
   done on a scratch database.
2. `pnpm exec wrangler d1 migrations list sadec_pilot --remote` lists a migration
   this checkout does not contain — the remote schema is ahead of the code.
3. The migration stops part-way: the ledger row is absent, so the database is at
   the previous migration. Fix the cause and re-run; do not edit an applied file.
4. The bootstrap prints a refusal you do not understand, or exits 1 ("the write
   failed and I cannot tell you whether it landed"). Run the preview and read the
   rows; do not retry.
5. Two founder rows exist for the pilot workspace, or a `provisioning` audit row
   exists without the membership it gates.
6. A real Access token is rejected after a deploy that claims to be configured.
7. A receipt is recorded with no bank reference verified by a human.

## What is missing before "ready to submit for CI and pilot"

- A GitHub run of `.github/workflows/verify.yml` on the release-candidate SHA, and
  its check name.
- The three Access values, and a real token accepted on the deployed host.
- A pilot backup and one rehearsed restore of *that* file, by the owner of the data.
- The remote atomicity probe on a throwaway D1 database: a `--file` script that
  writes then fails, read back empty, then the same script without the failure,
  read back complete. Documented in `docs/PILOT-RUNBOOK.md` §6; **not performed**.
- `0007` applied to the pilot database, with the ledger recorded before and after.
- The first remote bootstrap, read back.
- Decisions nobody has made: carrier-fault cost allocation, partial pilot credit,
  per-workspace deposit rate, whether order status follows delivery, driver-contact
  visibility scope, and who holds database rights for provisioning.
- A route in the application to grant or revoke a membership; today the first
  membership comes from the bootstrap command and a mistake is undone by revoking
  it in SQL, not from a screen.
