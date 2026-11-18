# Phase 3 — Void Pending Receipt (`pending -> voided`)

## Goal
Allow authorized workspace members (`founder_admin`, `workspace_owner`, `workspace_operator`) to void an unconfirmed (`pending`) receipt with a mandatory reason, atomic `receipt_events` + `audit_events` trail, idempotency, concurrency safety against `confirmReceipt`, zero impact on `collected_vnd`, and exclusion from `TodaySummary.deposits_to_confirm`.

## Exact Steps
1. **RBAC & Domain FSM (`src/security/authorize.ts`, `src/ops/quote-revisions.ts`):**
   - Add `'receipt.void': ['founder_admin', 'workspace_owner', 'workspace_operator']` to `PERMITTED_ROLES` in `src/security/authorize.ts`.
   - Extend `RECEIPT_STATUSES` in `src/ops/quote-revisions.ts` to `['pending', 'confirmed', 'reversed', 'voided']` (`confirmed` -> `reversed`; `pending` -> `confirmed | voided`; `voided` and `reversed` terminal).
2. **Transaction `voidReceipt` (`src/ops/transactions.ts`):**
   - Signature: `voidReceipt(db, { workspaceId, receiptId, reason, actorId })` (plus positional overload matching `reverseReceipt`).
   - Validate `memberActor` (`403` if non-member) and non-empty trimmed `reason` (`400 validation` if blank).
   - Pre-read receipt scoped by `workspace_id` (`404 not_found` if missing):
     - If `receipt.status === 'voided'`: return `ok({ ...receipt, receipt, changed: false })` (idempotent repeat void).
     - If `receipt.status !== 'pending'` (`'confirmed'` or `'reversed'`): refuse with `409 invalid_state` explaining confirmed receipts must be reversed rather than voided.
   - Execute atomic `db.batch()`:
     - Statement 0 (gate): `INSERT INTO receipt_events (id, receipt_id, kind, actor_id, amount_vnd, detail, created_at) SELECT ?, r.id, 'void', ?, r.amount_vnd, ?, ? FROM receipts r WHERE r.id = ? AND r.workspace_id = ? AND r.status = 'pending'`
     - Statement 1: `UPDATE receipts SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM receipt_events e WHERE e.id = ?)`
     - Statement 2: `INSERT INTO audit_events (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at) SELECT ?, ?, ?, 'receipt.voided', 'receipt', ?, ?, ? WHERE EXISTS (SELECT 1 FROM receipt_events e WHERE e.id = ?)`
     - Never touch `orders.collected_vnd` or `orders.status`.
   - If `changesAt(results, 0) === 0`, re-read receipt: if now `'voided'`, return `ok({ ...latest, receipt: latest, changed: false })`; otherwise (`'confirmed'` won a concurrent race) return `409 invalid_state`.
   - Update `ReceiptRow` columns in all `SELECT` queries (`readReceipt`, `listReceipts`, etc.) to include `void_reason`, `voided_by`, `voided_at`.
   - Confirm `readTodaySummary` (`WHERE status = 'pending'`) excludes `'voided'` receipts from `deposits_to_confirm` and `pendingReceipts`.
3. **HTTP Route (`src/ops/routes.ts`, `src/worker/index.ts`):**
   - Add `voidReceiptSchema` (`{ receipt_id, reason }`) and `handleVoidReceipt(opsActor, body)`.
   - Register `{ kind: 'guarded', path: '/api/receipts/void', action: 'receipt.void' }`, include `/api/receipts/void` in `IDEMPOTENT_ROUTES`, and wire dispatch with `opsActor`.
4. **Tests (`test/authorize.test.ts`, `test/nursery-transactions.test.ts`):**
   - RBAC matrix for `receipt.void` (operator/owner/founder allowed in own workspace; non-member/cross-workspace denied).
   - Happy path `pending -> voided` records `receipt_events(kind='void')` + `audit_events(action='receipt.voided')`, leaves `orders.collected_vnd` unchanged, keeps row in `listReceipts`, and removes it from `readTodaySummary.deposits_to_confirm`.
   - Blank reason -> `400`; `confirmed` receipt -> `409`; `reversed` receipt -> `409`; repeat void -> `200` (`changed: false`, single event row).
   - Concurrent `Promise.all([confirmReceipt(...), voidReceipt(...)])` -> one `ok`, one `refused` (`409`), consistent `collected_vnd`.
   - Losing `80k` pending receipt from the `100k` remaining / two-`80k` race can be cleanly voided so `deposits_to_confirm` drops to `0`.

## Acceptance Criteria
- Every receipt void state transition, concurrency race, RBAC check, and `TodaySummary` count invariant is verified by automated tests.
