---
phase: 2
status: pending
owner: lane-a
depends_on: 1
parallel_safe: true
parallel_with: 3
---

# Phase 2 — Operations transactions

Lane A owns this. It runs in parallel with phase 3 in a separate worktree. The
disjoint boundary is absolute: phase 2 writes `src/ops/**` and `test/ops/**`
only, and phase 3 writes `src/founder/**` and `test/founder/**` only.

## Context

§7.2 and §7.3 are the most exacting requirements in the spec, and §15 tests them
in cases 3, 4, 5, 12 and 13. This is the phase where a mistake costs a customer
real money, so the invariants are enforced by the database rather than by
application code that a later edit could bypass.

## Requirements

1. Quote states: draft, issued, accepted, declined, expired, superseded. Issuing
   freezes a snapshot of item name and spec, quantity, unit price, discount,
   fees, total, validity and conditions. The server computes the total; a total in
   the request body is ignored.
2. Editing an issued quote creates a new revision and keeps the old one with an
   audit trail. In one revision chain exactly one revision may be accepted and
   exactly one order may exist.
3. Order creation from an accepted revision is idempotent. Retrying cannot create
   a second order, and accepting two revisions at once cannot either.
4. Receipts have pending, confirmed and reversed states. Only confirmed receipts
   that are not reversed count toward collected. Confirming is manual, requires
   the right role, a timestamp and a reference — a transfer screenshot never
   self-confirms.
5. A confirmed receipt is never edited or deleted silently. Corrections happen
   through a reversal or an offsetting entry with a reason and an audit record.
6. Confirming the same receipt twice does not add money twice.
7. Over-payment is refused with a stated reason. Over-payment refusal and pilot
   credit application must be ordered: credit applies first, then the balance
   check.
8. Delivery dates, delivery status and follow-up tasks have real CRUD with an
   owner.
9. Order status transitions are validated server-side.
10. A printable quote: A4-readable, carries quote and revision codes, terms and
    expiry, and is visibly a quote rather than a tax invoice.

## Files

Owned: `src/ops/**`, `test/ops/**`, `src/ui/ops/**`.

Read-only: `src/shared/**`, `src/domain/money.ts`, `src/domain/economics.ts`,
`migrations/**`. A new migration, if needed, is requested from the integrator.

## Steps

1. Enforce the money invariants with database constraints so that a losing race
   produces a real SQL error and the whole batch rolls back. Concretely:
   - `UNIQUE(quote_chain_id)` on orders, plus a partial unique index on quote
     revisions limited to the accepted revision.
   - `UNIQUE(receipt_id, kind)` on the receipt event table, so a retried confirm
     is blocked rather than double-counted.
   - `UNIQUE(pilot_receipt_id)` on pilot credit, so credit is used once.
   - A check constraint bounding collected against the order total.
   Read `meta.changes` after any conditional update and treat zero as a refusal
   that returns 409, never as a silent success. §11 warns that D1's `batch()` is
   a SQL transaction, not a row lock, and that an update matching zero rows is
   not an error.
2. Build quote draft → issue → snapshot → accept, then order creation.
3. Build receipts with confirm and reverse, each with an audit row.
4. Build delivery and follow-up tasks.
5. Build the printable quote page.
6. Write the §15 tests this phase owes: case 3 (server arithmetic and rejection of
   invalid data), case 4 (changing catalogue or config does not move an issued
   quote or an existing order), and the concurrency halves of case 5. Case 5's
   third part — an order with 100,000đ outstanding and two independent 80,000đ
   receipts confirmed simultaneously — must be tested with genuinely concurrent
   requests, then read back from the database to confirm exactly one receipt
   survived. A sequential test proves nothing.

## Validation

- §15 case 3, 4 and 5 pass, with case 5 verified by reading database state rather
  than status codes alone.
- Test output reports a non-zero count.
- Mutations carry origin and CSRF protection appropriate to a cookie-based auth
  scheme.
- No route accepts a client-supplied total, role, or `workspace_id` (§6, §7.2).
- The printed quote is readable on A4 and states it is not a tax invoice.

## Risks and rollback

The concurrency tests are the ones most likely to be quietly wrong: a test that
passes because requests were serialized looks identical to one that passes
because the invariant holds. Mitigation: assert on database state after the race,
and re-run the race repeatedly rather than once. If a required invariant cannot
be expressed as a constraint, stop and report rather than falling back to
application-side checking that a later edit can bypass.
