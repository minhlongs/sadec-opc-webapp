---
phase: 3
status: pending
owner: lane-b
depends_on: 1
parallel_safe: true
parallel_with: 2
---

# Phase 3 — Founder discovery, config versions and OPC economics

Lane B owns this. It runs in parallel with phase 2. Boundary: `src/founder/**`
and `test/founder/**` only.

## Context

§8 through §13 are the part that survives the demo. The three-layer separation —
Observation, ChangeProposal, ConfigVersion — is what lets real interview data
change the app without a code change, which is the founder's stated goal. §13's
OPC ledger is quietly the heaviest object in the spec: agreements, manually
recorded obligations, receipt allocation, single-use pilot credit, and three
distinct metrics (active MRR, cash collected in a period, outstanding
receivable) that must never be conflated.

## Requirements

1. Interviews carry `id`, `external_id`, `organization_alias`,
   `respondent_role`, `interviewed_at`, `data_origin`, notes, `recorded_by`,
   `created_at` and `revision`. Observations carry `metric_key`, `value`, `unit`,
   `period`, `evidence_kind` and `source_ref`. `evidence_kind` is one of
   reported, measured, assumption.
2. `metric_key` is an allowlist, not free text. New keys are added deliberately,
   not accepted from an import.
3. Semantics are enforced: an omitted field is not provided, `null` is unknown,
   `0` is a stated zero, and an empty string is never coerced to zero. A
   `parseOptional` helper is written once and used everywhere, because §9's
   zero-versus-null distinction is exactly where JSON and CSV will diverge.
4. Observations are append-only with a revision column. A proposal pins immutable
   observation revisions or an approved evidence snapshot. If an interview is
   corrected, old decisions keep their original source, and an unapplied proposal
   must report that a newer source revision exists. `data_origin` is never edited
   from synthetic to real.
5. ChangeProposal carries scope, optional `workspace_id`, `base_version_id`,
   changes, evidence ids, rationale, status, and who approved it when.
6. The active config pointer is keyed by `(scope, workspace_id)`.
   `business_model` is global; `workspace_operations` is per workspace. Both use
   the same apply core so the two flows cannot drift apart.
7. Applying checks the role and that the base version is still current, then
   creates an immutable ConfigVersion, moves the active pointer, and writes an
   audit row — all or nothing. Two people approving from the same base: one wins,
   the other gets a conflict and must rebase over the diff.
8. Rollback creates a new version copied from an older one. It deletes nothing.
9. Import and export: JSON with `schema_version` and stable `external_id`; CSV
   with a published UTF-8 header and template, handling embedded commas, quotes
   and multi-line notes correctly. Limits of 256 KiB and 500 observations per
   import are shown before upload. Validate everything, preview per-line errors,
   and never apply partially. Re-importing the same `external_id` with the same
   content does not duplicate; the same id with different content becomes a
   revision proposal. Synthetic data is refused in pilot.
10. Exports are role-scoped, carry no tokens, and escape cells that a spreadsheet
    could read as a formula.
11. Economics: one domain function implementing all §13 formulas. Scenario and
    actual results are different kinds and are labelled as such at the API, not
    only in the UI. A zero denominator shows "undefined" with the reason rather
    than a fabricated number.
12. The OPC ledger: agreements with status, dates and a price-plane snapshot;
    manual receipts with status, date, fee type, reference and confirmer;
    manually recorded obligations with amount, due date and credit. Receipts
    allocate to specific obligations. Outstanding receivable comes only from
    recorded obligations, minus confirmed receipts and valid credit — never from
    MRR.
13. Pilot credit links to the qualifying pilot receipt and is usable once.
14. A prepaid twelve-month subscription does not become one month of MRR. Setup
    and pilot fees are excluded from MRR.

## Files

Owned: `src/founder/**`, `test/founder/**`, `src/ui/founder/**`.

Read-only: `src/shared/**`, `src/domain/economics.ts`,
`src/domain/rounding.ts`, `migrations/**`.

This phase does not read money logic from phase 2 outside the OPC agreement
tables, and it does not touch quote or order tables. The two ledgers in §8 stay
separate even where the arithmetic looks identical — that is the point of §8, and
sharing a write path would let a plant deposit land in OPC revenue.

## Steps

1. Build interviews and observations with the import pipeline: validate → preview
   → explicit confirm → apply. The fixture in §12 is the test input, and the test
   proves that missing, null and stated-zero are displayed differently (§15
   case 8) and that a duplicate import does not replicate while a differing
   same-id import produces a revision (case 9).
2. Build proposals and the config version machinery with the apply core shared
   between both scopes. Test that a rejected proposal changes nothing, that an
   applied proposal applies exactly the approved payload, and that concurrent
   applies from one base produce exactly one winner and a conflict for the other.
3. Build the economics screen on the shared function, with the three §13 rows as
   its test oracle.
4. Build the OPC agreement ledger, obligations, pilot credit and receipts, plus
   the specific example in §13: a 3,000,000đ pilot fee plus a 10,000,000đ
   upgrade obligation less 3,000,000đ credit plus a 7,000,000đ upgrade receipt
   must total 10,000,000đ actually received with zero remaining obligation.
5. Build data export with role scoping and formula escaping.
6. Resolve the authorization question left open in `plan.md`: who may record
   obligations and allocate receipts. Record the answer in `docs/DECISIONS.md`
   before writing those routes.

## Validation

- §15 cases 8, 9, 10, 11, 13, 14 pass. Case 14 specifically requires that
  changing an input recomputes from the same domain function, so the UI and the
  test must call the same function.
- The three §13 rows match the recorded values exactly.
- No proposal changes config without an audit row, and no losing apply leaves a
  phantom ConfigVersion or audit record.
- Synthetic data never appears in a pilot import or in the real dashboard.
- Founder-only data — research notes, willingness to pay — never returns on a
  workspace-scoped request (§6, §8).

## Risks and rollback

The OPC obligation ledger is where the spec is most under-specified about who may
write what. If that question cannot be settled without the founder, stop and ask
rather than guessing an authorization rule — the founder cannot verify
authorization by clicking through the app, so a wrong guess here is invisible to
them.
