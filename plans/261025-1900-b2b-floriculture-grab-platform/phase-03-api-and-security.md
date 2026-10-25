# Phase 03 — API Routes & Security Chokepoint

## Context & Objectives
Mở rộng `src/security/authorize.ts` và đăng ký các route B2B vào `src/worker/index.ts` thông qua `src/ops/b2b-routes.ts` và `src/ops/b2b-catalog.ts`. Mọi route đều bắt buộc đi qua `authorize` và kiểm tra `Sec-Fetch-Site` cho các lệnh ghi.

## Files Owned
- `src/security/authorize.ts` (Modify)
- `src/worker/index.ts` (Modify)
- `src/ops/b2b-catalog.ts` (New)
- `src/ops/b2b-routes.ts` (New)
- `test/b2b-routes.test.ts` (New)

## Implementation Details
1. **Actions trong `PERMITTED_ROLES` (`src/security/authorize.ts`)**:
   - `'marketplace.lot.read'`: `['founder_admin', 'workspace_owner', 'workspace_operator']`
   - `'marketplace.lot.write'`: `['founder_admin', 'workspace_owner']`
   - `'marketplace.booking.read'`: `['founder_admin', 'workspace_owner', 'workspace_operator']`
   - `'marketplace.booking.write'`: `['founder_admin', 'workspace_owner', 'workspace_operator']`
   - `'marketplace.escrow.confirm'`: `['founder_admin']`
   - `'hub.dispatch.read'`: `['founder_admin', 'workspace_owner', 'workspace_operator']`
   - `'hub.dispatch.write'`: `['founder_admin']`
   - `'marketplace.inspect.settle'`: `['founder_admin', 'workspace_owner', 'workspace_operator']` (ràng buộc `auth.workspaceId === booking.buyer_workspace_id || auth.role === 'founder_admin'`)
   - `'founder.pilot.read'`: `['founder_admin', 'workspace_owner']`
2. **Registered Routes trong `src/worker/index.ts`**:
   - `GET /api/b2b/lots` (`marketplace.lot.read`): Danh sách lô hàng 2 chế độ (`WEEKLY_CATALOG` & `SEASONAL_PREORDER`) kèm thông tin vườn xác minh và QR lô.
   - `POST /api/b2b/lots/create` (`marketplace.lot.write`): Nhà vườn đăng lô hàng mới.
   - `GET /api/b2b/bookings` (`marketplace.booking.read`): Danh sách đơn đặt giữ lô, mã VietQR cọc, trạng thái sổ cái Escrow.
   - `POST /api/b2b/bookings/create` (`marketplace.booking.write`): Shop TP.HCM đặt giữ lô (tự động tính cọc 30–50% và phí sàn 2–5% trên server, không tin client).
   - `POST /api/b2b/bookings/confirm-deposit` (`marketplace.escrow.confirm`): Xác nhận nhận cọc VietQR → chuyển trạng thái `ESCROW_HELD` và ghi dòng `DEPOSIT_HELD` vào `escrow_ledger_entries`.
   - `GET /api/b2b/hub-trips` (`hub.dispatch.read`): Danh sách chuyến xe ghép Sa Đéc → TP.HCM và các kiện hàng QR.
   - `POST /api/b2b/hub-packages/verify` (`hub.dispatch.write`): Hub Sa Đéc kiểm định quy cách, cấp mã QR kiện hàng (`HMAC-SHA256`), xếp lên chuyến xe (`HUB_CONSOLIDATED`).
   - `POST /api/b2b/bookings/inspect-and-settle` (`marketplace.inspect.settle`): Shop TP.HCM quét mã QR kiện hàng nghiệm thu (Đạt 100%, Lỗi một phần do vườn, hoặc Từ chối toàn bộ do lỗi vườn) → tự động tạo bút toán sổ cái bất biến và chuyển trạng thái `SETTLED`.
   - `GET /api/b2b/pilot-dashboard` (`founder.pilot.read`): Trả về 4 chỉ số Pilot KPI và trạng thái cân bằng sổ cái (`unbalanced_settled_bookings === 0`).

## Verification
- Chạy `pnpm vitest run test/b2b-routes.test.ts test/api-registry.test.ts test/authorize.test.ts` pass 100%.
