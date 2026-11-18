# Sa Đéc Flow V1 — Local Release Verification Notes (2026-11-18)

- **Branch:** `feat/sadec-v1-local-verified`
- **Base Commit:** `5a2ffd8816adc3fdcf330a5040c56d46b7a3362d`
- **Commit 1 (Forensic Hardening):** `5cab4634c4c2c0b475b673084376365f268ec361`
- **Commit 2 (V1 Pilot Completion):** `53a7194fc0a275e7b021879226f879545cbd27af`
- **Deployment / Remote State:** Local verification only (`DEMO_LIVE_VERIFIED = no`, `PILOT_LIVE_VERIFIED = no`, `Production = HOLD`, `Push/Merge = NOT AUTHORIZED`)

---

## 1. Summary of Shipped V1 Capabilities

### Forensic Hardening Baseline (`5cab463`)
- **Integer VND & Basis-Point Precision (`src/domain/money.ts`, `src/ops/quote-revisions.ts`):** Eliminates IEEE-754 float scaling in `depositRequired`, enforces integer basis points (`0..10_000`), and computes `multiplyByBasisPoints` via `BigInt` intermediate arithmetic up to `MAX_VND` with truncation toward zero.
- **Order & Follow-Up Plumbing (`src/worker/index.ts`, `src/ops/routes.ts`, `src/ui/api.ts`, `src/ui/components/screens.tsx`):** Restores authenticated `actorId` plumbing on `POST /api/orders/transition` and aligns UI follow-up completion status with backend `completed`.
- **Printable A4 Quote Security & Layout (`src/ops/transactions.ts`):** HTML-escapes every interpolated customer, line-item, chain, and note field in `getPrintableQuoteHtml`, adds `@page { size: A4; margin: 14mm }` and `@media print` styling, and enforces workspace-scoped customer joins on `?format=json`.
- **Receipt Reversal & Delivery Concurrency (`src/ops/transactions.ts`):** Reverts `orders.status` from `deposit_confirmed` back to `pending_deposit` when `reverseReceipt` drops confirmed collection below `deposit_required_vnd`, and moves the deposit coverage check inside the atomic SQL `WHERE` predicate of `updateDeliveryStatus`.
- **Tenant-Scoped Order Codes (`migrations/0008_orders_workspace_order_code.sql`):** Replaces global `UNIQUE(order_code)` with `UNIQUE(workspace_id, order_code)` so independent workspaces accepting `BG-0001` v1 never collide.
- **Live Smoke CSRF Regression Coverage (`test/smoke-live.test.ts`, `e2e/founder-flow.spec.ts`, `e2e/smoke.spec.ts`):** Enforces `Sec-Fetch-Site` validation in the `smoke-live` test stand-in, exercises real `pilot_credits` single-use application in Founder E2E, and asserts mandatory `390` and `1440` viewport widths.

### V1 Pilot Completion (`53a7194`)
- **Nursery / OPC Ledger Wall (`src/ops/transactions.ts`):** Enforces hard separation between Nursery Ops (`orders`, `receipts`) and the Founder OPC commercial ledger (`opc_obligations`, `opc_receipts`, `pilot_credits`). Nursery `acceptRevision` refuses non-zero `pilotCreditVnd` (`400`), and nursery remaining-balance / deposit-threshold SQL evaluates `total_vnd - collected_vnd` and `collected_vnd >= deposit_required_vnd` directly.
- **Migration `0009_receipt_void.sql`:**
  - Extends `receipts.status` to `('pending', 'confirmed', 'reversed', 'voided')` with `void_reason`, `voided_by`, and `voided_at` columns plus workspace-status indexing.
  - Extends `receipt_events.kind` to `('record', 'confirm', 'reverse', 'void')` while preserving `UNIQUE (receipt_id, kind)`.
  - Adds `quote_revisions.customer_snapshot_json` to preserve point-in-time customer details on issued quotes.
- **Product & Customer Editing with Optimistic Locking (`POST /api/products/update`, `POST /api/customers/update`):**
  - Enforces RBAC (`product.write`: `founder_admin`, `workspace_owner`; `customer.write`: `founder_admin`, `workspace_owner`, `workspace_operator`), HTTP `Idempotency-Key`, and `WHERE id = ? AND workspace_id = ? AND updated_at = ?` optimistic locking (`409 conflict` on stale edits).
  - Records `product.updated` and `customer.updated` rows in `audit_events`.
  - Freezes `customer_snapshot_json` when `issueRevision` transitions a quote revision from `draft` to `issued`; printable A4 quotes and JSON print views render the frozen snapshot for issued/accepted revisions so subsequent customer edits never rewrite historical quotes.
- **Vietnamese-Aware Workspace Search (`GET /api/products?q=`, `GET /api/customers?q=`):**
  - Normalizes queries via Unicode NFC, strips combining marks, folds `đ/Đ -> d`, splits whitespace tokens (capped at 120 chars), and filters strictly within `workspace_id` across product `name`, `species`, `unit`, `spec` and customer `name`, `contact_name`, `phone`, `address_area`.
- **Pending Receipt Voiding (`POST /api/receipts/void`):**
  - Allows `workspace_operator`, `workspace_owner`, and `founder_admin` (`receipt.void`) to cancel unconfirmed (`pending`) receipts with a mandatory trimmed reason (`1..500` chars).
  - Uses the atomic D1 `db.batch()` gate-insert pattern on `receipt_events(kind='void')` so `confirmReceipt` vs `voidReceipt` races never double-apply or corrupt `orders.collected_vnd`.
  - Re-voiding an already `voided` receipt returns idempotent `200` (`already_voided: true`); voiding `confirmed` or `reversed` receipts refuses with `409 invalid_state` (confirmed receipts continue to require owner/founder `reverseReceipt`).
  - Excludes `voided` receipts from `TodaySummary.deposits_to_confirm`.
- **Nursery Ops UI (`src/ui/components/screens.tsx`, `src/ui/api.ts`):**
  - Adds debounced search inputs (`200ms`), inline create/edit panels (`0 VND` consultation line items allowed), role-aware edit visibility, `409` optimistic-lock reload banner, pending receipt creation form, and inline void-reason flow verified at `390×844` and `1440×900`.

---

## 2. Release Gate Matrix (G0–G10)

| Gate | Requirement | Verdict | Evidence |
| :--- | :--- | :--- | :--- |
| **G0** | Clean git baseline & conventional commit separation | **PASS** | `5cab463` (hardening) and `53a7194` (pilot completion) on `feat/sadec-v1-local-verified`; zero secrets or `.sqlite` files tracked |
| **G1** | TypeScript strict typecheck (`tsc --noEmit`) & Vite bundle build | **PASS** | `pnpm verify` (`typecheck` 0 errors, `vite build` succeeded) |
| **G2** | Integer VND & basis-point precision invariants | **PASS** | `test/money.test.ts` + `src/domain/money.ts` (`BigInt` intermediate scaling, truncation toward zero, `MAX_VND` ceiling) |
| **G3** | Nursery / OPC commercial ledger separation | **PASS** | `src/ops/transactions.ts` + `test/nursery-transactions.test.ts` + `test/founder-transactions.test.ts` + `e2e/founder-flow.spec.ts` |
| **G4** | Schema migrations `0001..0009` fresh + upgrade + zero drift | **PASS** | `test/migration-0008.test.ts`, `test/migration-0009.test.ts`, `pnpm db:migrate:local -- --env demo/test`, `pnpm db:migration-drift` (9/9 match) |
| **G5** | D1 local backup, scratch restore readback & SQLite integrity drill | **PASS** | `pnpm db:backup -- --env demo/test`, `pnpm db:restore:test -- --env test`, `pnpm db:restore:drill` (33 tables, `integrity ok`, `foreign_key_check clean`, 0 orphans) |
| **G6** | Auth, RBAC chokepoint & cross-tenant isolation | **PASS** | `test/authorize.test.ts`, `test/worker-auth.test.ts`, `test/tenant-boundary.test.ts`, `test/cross-tenant-b2b.test.ts` (`receipt.void`, `product.write`, `customer.write`) |
| **G7** | Product/customer optimistic-lock edits & quote snapshot immutability | **PASS** | `test/nursery-transactions.test.ts` + `e2e/phase4-ops-ui.spec.ts` (`409` stale `expected_updated_at` conflict, issued quote snapshot unchanged) |
| **G8** | Vietnamese-aware diacritic-insensitive workspace search | **PASS** | `test/nursery-transactions.test.ts`, `e2e/nursery-flow.spec.ts`, `e2e/phase4-ops-ui.spec.ts` (`"lan y"` -> `"Lan Ý"`, `"binh thanh"` / phone search) |
| **G9** | Pending receipt voiding, idempotency, race safety & Today KPI accuracy | **PASS** | `test/nursery-transactions.test.ts` (`confirm` vs `void` `Promise.all` race), `e2e/nursery-flow.spec.ts`, `e2e/phase4-ops-ui.spec.ts` (`deposits_to_confirm` decrement) |
| **G10** | Full Vitest + Dual-Viewport Playwright E2E (`390×844` & `1440×900`, `retries: 0`) & Code Hygiene | **PASS** | **47 test files / 723 Vitest tests passed**; **62 Playwright E2E tests passed** (`retries: 0`); 0 `: any`, `as any`, `console.log`, `TODO`, `FIXME` in `src/` |
