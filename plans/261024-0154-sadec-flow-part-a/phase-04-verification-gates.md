---
phase: 4
status: pending
owner: integrator
depends_on: 2,3
parallel_safe: false
---

# Phase 4 — Verification, evidence and acceptance

Single-owner again. This phase merges the lanes and turns their claims into
evidence. It is also where the founder's own constraint — no code reading — is
satisfied or not.

## Context

§15 lists seventeen cases that must carry evidence, and §19 states that
`LOCAL_VERIFIED` requires a verified end-to-end UI journey plus persistence,
permissions, and the money, history and update invariants applied locally.
Missing the UI gate or any mandatory gate means `LOCAL_PARTIAL`. §15 also
forbids marking a case PASS when the check did not run.

## Requirements

1. Every one of the 17 §15 cases has a row in `docs/RELEASE.md` with the command
   that ran it, the exit status, and the concrete result. A case that could not
   run is recorded as blocked with the reason — never PASS.
2. `pnpm verify` output includes the count of files and tests. A run reporting
   zero tests is a failure.
3. Export and restore are actually exercised against a separate test database,
   not described in a README (§15 case 15, §14).
4. Workspace isolation is tested in two groups (§15 case 6), because the
   spec's two halves are different failure modes:
   - Every route taking an `:id` parameter — the traditional tampered-identifier
     case, including export and single-object access.
   - Every route with no `:id` — list, report, export and apply routes such as
     `GET /api/interviews` and `GET /api/founder/exports`. These return rows by
     ownership rather than by identifier, so a missing `workspace_id` in the
     query leaks rather than 404s. Each is tested by calling it with a
     workspace-B identity and asserting the row count equals B's, proving the
     filter runs in the query rather than after it. Founder-only data —
     research notes, willingness to pay — is the data at stake, and it must
     never appear on a workspace-scoped response.
5. Role boundaries are tested directly, by asserting the server refuses the
   request (§15 case 7). Hiding a control does not satisfy this case: an operator
   who cannot publish founder parameters, cannot change permissions, and cannot
   confirm a deposit against policy must receive a refusal from the API even when
   the UI offers nothing to click. This is the case the founder cannot verify by
   clicking, so it carries its own recorded evidence rather than relying on the
   click-through document.
6. The economics cases are recomputed from the shared domain function (§15
   case 14).
7. Mobile and desktop are verified at 390px and 1440px with no severe console
   error and no inert primary call to action (§15 case 16).
8. Demo data does not contaminate a real customer KPI, and a reported willingness
   to pay never becomes revenue (§15 case 13).
9. `docs/ACCEPTANCE-CLICKTHROUGH.md` exists in Vietnamese with click steps,
   expected numbers, and screenshots, covering each money and permission
   invariant: an issued quote does not move when catalogue prices change; two tabs
   confirming 80,000đ on an order with 100,000đ outstanding leaves exactly one
   confirmed; an operator sees the publish control locked; null, zero and blank
   display differently.
10. A reviewer who did not build the code re-runs the README commands and the
    click-through document from a clean checkout, and records the result.

## Files

- `docs/RELEASE.md`, `docs/ACCEPTANCE-CLICKTHROUGH.md`, `docs/CHECKPOINT.md`
- `test/**` (cross-phase integration tests)
- `.gitignore` confirmation that no real interview data, local database, or backup
  is tracked

## Steps

1. Merge lane branches one at a time onto `feat/sadec-flow-part-a`, running the
   full suite after each merge and recording the counts.
2. Write and run the §15 cases that no single lane covers — 2, 6, 7, 12, 13, 15,
   16 — plus concurrency tests that read database state back rather than trusting
   status codes.
3. Exercise `db:backup` then `db:restore:test`, reading back row counts per table
   to prove the restore landed.
4. Capture screenshots at both breakpoints and assemble the acceptance document.
5. Have an independent reviewer run the whole thing from a clean checkout.

## Validation

- 16 of 17 cases carry evidence; case 17 is deferred to phase 5 because it
  requires a live protected URL.
- Every command listed in the README runs on a clean checkout with exit 0.
- No case in `docs/RELEASE.md` is marked PASS without a command and a result.
- The reviewer's independent run is recorded with its date and outcomes.

## Risks and rollback

The realistic failure is a case that looks green because a test was written to
confirm the implementation rather than the invariant. Mitigation is the
independent reviewer plus asserting on database state after races. If a case
cannot be evidenced, this phase reports `LOCAL_PARTIAL` and names the gap rather
than rounding up to `LOCAL_VERIFIED`.
