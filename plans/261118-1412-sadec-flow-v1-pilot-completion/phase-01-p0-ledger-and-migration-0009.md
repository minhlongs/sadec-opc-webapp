# Phase 1 — Migration `0009` & P0 Cross-Ledger Fix (`pilot_credit_applied_vnd`)

## Goal
Back up local D1 state, add additive migration `migrations/0009_receipt_void.sql` supporting pending-receipt voiding and frozen customer snapshots on issued quote revisions, and eliminate the P0 cross-ledger contamination path where `orders.pilot_credit_applied_vnd` could satisfy nursery plant deposits or reduce remaining nursery order balances.

## Exact Steps
1. **Local Database Backup:** If `.wrangler/` exists locally, copy a timestamped backup into gitignored `backups/` before running any schema migration.
2. **Create `migrations/0009_receipt_void.sql`** following `0008_orders_workspace_order_code.sql`'s D1-safe staging pattern:
   - Stage `receipt_events` into `receipt_events_stage` and `receipts` into `receipts_stage`; drop `receipt_events` then `receipts`.
   - Recreate `receipts` with:
     - `status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'reversed', 'voided'))`
     - `void_reason TEXT`, `voided_by TEXT REFERENCES identities(id)`, `voided_at TEXT` alongside existing columns; restore all rows from `receipts_stage` (`NULL` for new void columns); recreate `receipts_by_order` and workspace index `(workspace_id, status, created_at DESC)`.
   - Recreate `receipt_events` with `kind TEXT NOT NULL CHECK (kind IN ('create', 'confirm', 'reverse', 'void'))` and `UNIQUE (receipt_id, kind)`; restore rows from `receipt_events_stage`; recreate `receipt_events_by_receipt`; drop staging tables.
   - Add `ALTER TABLE quote_revisions ADD COLUMN customer_snapshot_json TEXT;` so `issueRevision` freezes `{ name, contact_name, phone, address }` at issuance time.
3. **Fix P0 Cross-Ledger Defect in `src/ops/transactions.ts`:**
   - Remove `pilotCreditVnd` from `acceptRevision`'s public signature (if passed via untyped JS as non-zero, refuse with `400 validation`; always bind `0` into `orders.pilot_credit_applied_vnd`).
   - Update all 11 nursery order/deposit/receipt/delivery formulas and SQL predicates in `src/ops/transactions.ts` (`transitionOrder`, `createReceipt`, `remainingCollectable`, `confirmReceipt`, `reverseReceipt`, `createDelivery`, `updateDeliveryStatus`) so deposit coverage is strictly `collected_vnd >= deposit_required_vnd` and remaining collectable balance is strictly `total_vnd - collected_vnd`.
4. **Tests (`test/migration-0009.test.ts` & `test/nursery-transactions.test.ts`):**
   - Fresh migration `0001..0009` + seeded upgrade (`0001..0008` + `demo.sql` -> `0009`) preserving row counts, foreign keys (`PRAGMA foreign_key_check`), and existing receipt events.
   - Regression tests proving: (a) OPC SaaS `pilot_credits` never satisfy nursery plant deposits, (b) non-zero `pilotCreditVnd` on `acceptRevision` is rejected/ignored, and (c) even if a legacy `orders` row held non-zero `pilot_credit_applied_vnd`, nursery deposit gates and remaining balance still require real nursery `collected_vnd`.

## Acceptance Criteria
- `migrations/0009_receipt_void.sql` applies cleanly on both empty and seeded databases in `createSqliteD1` and local Wrangler D1.
- Zero nursery transaction SQL or TypeScript paths offset plant deposits or plant order balances using `pilot_credit_applied_vnd`.
