# Phase 2 — Product Editing, Customer Editing & Vietnamese Workspace Search

## Goal
Implement safe, audited, concurrency-guarded editing for catalog products and customers (preserving historical quote/order snapshots) plus fast Vietnamese-aware workspace search on products and customers.

## Exact Steps
1. **Product Editing (`src/ops/transactions.ts`, `src/ops/routes.ts`, `src/worker/index.ts`):**
   - Implement `updateProduct(db, { workspaceId, productId, name, species, sizeClass, grade, priceVnd, unit, stockNote, expectedUpdatedAt, actorId })`:
     - Validate actor membership via `memberActor`.
     - Validate non-empty trimmed `name` and `unit`; validate `priceVnd` via `assertSafeVnd(priceVnd)` and `priceVnd >= 0` (`0` VND valid; `null`/`undefined`/`NaN`/negative/float refused with `400 validation`).
     - Read current product in `workspaceId` (`404 not_found` if absent or wrong workspace). If `expectedUpdatedAt` does not match current `updated_at`, refuse with `409 conflict`.
     - Inside `db.batch()`, gate-insert `audit_events` (`action = 'product.updated'`, `WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND workspace_id = ? AND updated_at = ?)`) and `UPDATE products SET name = ?, species = ?, size_class = ?, grade = ?, price_vnd = ?, unit = ?, stock_note = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`. If `changesAt(results, 0) === 0`, return `409 conflict`.
   - Register `POST /api/products/update` with `action: 'product.write'` (`founder_admin`, `workspace_owner`; `workspace_operator` refused `403`) + `withIdempotency`, passing `opsActor`. Also ensure `handleCreateProduct` strictly distinguishes `null`/`""` price (`400`) from `0` (`201`).
2. **Customer Editing & Snapshot Preservation (`src/ops/transactions.ts`, `src/ops/routes.ts`, `src/worker/index.ts`):**
   - In `issueRevision`, snapshot `{ name, contact_name, phone, address }` from `customers` into `quote_revisions.customer_snapshot_json` inside the atomic issue update; update `getPrintableQuoteHtml` and `handlePrintableQuote` (`?format=json`) to read `customer_snapshot_json` when present (falling back to live `customers` for drafts and pre-`0009` rows, with `AND c.workspace_id = qc.workspace_id`).
   - Implement `updateCustomer(db, { workspaceId, customerId, name, contactName, phone, address, note, expectedUpdatedAt, actorId })` with the same `audit_events` (`customer.updated`) + `expected_updated_at` `db.batch()` concurrency guard (`409 conflict` on stale write, `404` on wrong workspace).
   - Register `POST /api/customers/update` with `action: 'customer.write'` (`founder_admin`, `workspace_owner`, `workspace_operator`) + `withIdempotency`, passing `opsActor`.
3. **Vietnamese Workspace Search (`src/ops/catalog.ts`, `src/ops/routes.ts`):**
   - Add pure helper `normalizeVietnameseSearch(text: string): string` (NFC normalize, lowercase, `đ/Đ -> d`, strip combining diacritics, collapse whitespace) alongside NFC lowercase substring matching so both accented (`"Đồng Tháp"`, `"Cau vàng"`) and unaccented (`"dong thap"`, `"cau vang"`, `"pd-a-01"`) queries match accurately, and special characters (`%`, `_`, `'`, `"`, `\`) are treated literally with zero SQL injection risk.
   - Extend `listActiveProducts(db, workspaceId, query?)` and `listCustomers(db, workspaceId, query?)` (SQL strictly binds `WHERE workspace_id = ?`) and wire `?q=` in `handleListProducts` and `handleListCustomers` (clamping `q` length to `<= 200`).
4. **Unit & Integration Tests (`test/ops-routes.test.ts`, `test/ops-transactions.test.ts`):**
   - Product edit: happy path, `0` VND vs `null`/negative/float refusal, `409` stale `expected_updated_at`, `403` operator refusal, cross-workspace `404`, issued quote line/total immutability after price change.
   - Customer edit: happy path, `409` stale `expected_updated_at`, cross-workspace `404`, existing quote chain/order customer link preserved, issued printable quote customer snapshot unchanged after customer edit.
   - Search: Vietnamese accented & unaccented queries, product code (`id`), phone/contact search, empty result, special SQL characters (`%`, `'`, `; DROP TABLE`), cross-workspace isolation.

## Acceptance Criteria
- All product edit, customer edit, snapshot immutability, and search unit/integration tests pass.
