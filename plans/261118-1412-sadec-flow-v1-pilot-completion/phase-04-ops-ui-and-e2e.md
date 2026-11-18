# Phase 4 — `OpsScreen` UI Workflows & Dual-Viewport Playwright E2E

## Goal
Expose product search/create/edit, customer search/create/edit, and pending-receipt create/void cleanly in `OpsScreen` (`390×844` mobile & `1440×900` desktop) and verify all new workflows in Playwright with `retries: 0`.

## Exact Steps
1. **Frontend API Client (`src/ui/api.ts`):**
   - Update `ProductView` (`created_at`, `updated_at`), `CustomerView` (`address`, `note`, `created_at`, `updated_at`), and `ReceiptView` (`status: 'pending' | 'confirmed' | 'reversed' | 'voided'`, `void_reason`).
   - Add `?q=` query parameter support on `fetchProducts(workspaceId, query?)` and `fetchCustomers(workspaceId, query?)`.
   - Add `createProductApi`, `updateProductApi`, `createCustomerApi`, `updateCustomerApi`, `createReceiptApi`, and `voidReceiptApi` (all sending `Idempotency-Key` headers).
2. **`OpsScreen` UI (`src/ui/components/screens.tsx`):**
   - Pass `role: Role` into `OpsScreen` (from `session.role` in `src/ui/app.tsx`) for display gating (`canWriteProducts = role === 'founder_admin' || role === 'workspace_owner'`), keeping server authorization authoritative.
   - **Catalog Panel (`#ops-catalog`):**
     - Search input (`id="product-search"`, placeholder `"Tìm tên cây, mã SP, quy cách…"`) updating displayed products via `fetchProducts(workspaceId, q)` + clear button + explicit empty-search message (`"Không tìm thấy mặt hàng khớp từ khóa."`).
     - Show product code (`product.id`) alongside name/unit; render `0₫` cleanly via `formatVndWithUnit(0)`.
     - For `canWriteProducts`, provide compact inline "Thêm mặt hàng" / "Sửa" form (`name`, `species`, `size_class`, `grade`, `price_vnd`, `unit`, `stock_note`) sending `expected_updated_at` on edit and surfacing validation (`400`) or stale-edit (`409`) errors in Vietnamese without losing typed values.
   - **Customers Panel (`#ops-customers`):**
     - Dedicated compact customer directory & search section (`id="customer-search"`, placeholder `"Tìm tên khách, người liên hệ, SĐT…"`) + empty-search state + "Thêm khách" / "Sửa" inline form (`name`, `contact_name`, `phone`, `address`, `note`) sending `expected_updated_at` on edit; syncing updated customers into the quote composer dropdown as well.
   - **Receipts Section (`#ops-orders` -> `Phiếu thu tiền`):**
     - Add compact "Ghi phiếu thu chờ xác nhận" form (`order_id`, `amount_vnd`, `reference`, `note`) calling `createReceiptApi`.
     - On `rc.status === 'pending'`, show `"Xác nhận thực thu"` (for owner/founder) and `"Hủy phiếu chờ"` (opening inline reason input + confirm button calling `voidReceiptApi`), and render `'voided'` badge + `void_reason` hint in receipt history.
   - Verify mobile (`390×844`) and desktop (`1440×900`) layout has zero horizontal overflow or clipped controls.
3. **Playwright E2E Suite (`e2e/v1-pilot-completion.spec.ts`):**
   - Across both `mobile-390` (`390×844`) and `desktop-1440` (`1440×900`):
     - **Product create & edit (`:5174` founder/owner) + reload persistence + `0₫` valid + empty price refused**, and verify existing issued quote total/print remains unchanged.
     - **Customer edit (`:5173` operator) + reload persistence**, and verify existing order/quote linkage remains intact.
     - **Product & customer search (`:5173`)**: Vietnamese accented & unaccented queries, product code (`pd-a-01`), customer phone/contact, and no-match empty state.
     - **Pending receipt create -> void with reason -> reload persistence (`:5173`)**: verify receipt shows `voided` in history, order `collected_vnd` stays unchanged, and `Today` pending-deposits count excludes the voided receipt.

## Acceptance Criteria
- `pnpm test:e2e` passes 100% across both `mobile-390` and `desktop-1440` with `retries: 0`.
