---
title: "Gap map — chuỗi UI → API → phân quyền → domain → D1 → audit → UI đọc lại"
status: in_progress
created_at: 2026-10-29T15:30:00Z
branch: arena/6a7d60c9-sadec-opc-webapp
baseline_commit: 0f2e0dd337f85bb555e662770a7ab5207fead340
---

# Gap map (Phase A)

Mọi dòng dưới đây được đối chiếu với **mã nguồn và test**, không với tài liệu.
Nhãn bằng chứng: `local` = chạy trong sandbox này; `CI` = chưa có workflow nên
chưa có; `live` = không kiểm chứng được từ sandbox (không có quyền Cloudflare).

## 0. Baseline (local, 2026-10-29)

| Hạng mục | Kết quả | Ghi chú |
| --- | --- | --- |
| Runtime | node v22.22.3, pnpm 12.14.0 (corepack) | theo `packageManager` |
| `pnpm install --frozen-lockfile` | OK | |
| `pnpm typecheck` | PASS | |
| `pnpm test` | PASS — 22 file / 220 test | đếm thật, không lấy từ CHECKPOINT |
| `pnpm build` | PASS | |
| `pnpm verify` | **FAIL giả** ở bước test | `scripts/verify.ts` parse đếm test trên output có mã màu ANSI → `null` → FAIL dù vitest xanh |
| `pnpm test:e2e` | **22 pass / 2 fail** | 2 fail đều là `công tắc Đổi vườn chuyển đổi giữa ws-demo-a và ws-demo-b` (390 và 1440) — lỗi thật, xem §B |
| Migration local | 0001–0004 áp lên DB trống `sadec_demo`, seed demo áp xong | qua `pnpm db:migrate:local -- --env demo` + `db:seed:demo` |
| Trình duyệt E2E | Playwright CDN bị chặn trong sandbox; dùng Chromium 153 (`@sparticuz/chromium`, ngoài repo) qua biến `SADEC_E2E_CHROMIUM_PATH` | CI dùng `playwright install --with-deps` như bình thường |

Nguyên nhân E2E fail (đọc mã, không đoán): `src/ui/app.tsx` toggle cứng
`ws-demo-a ⇄ ws-demo-b`; seed cho `demo:sub:operator` thành viên của
`ws-demo-a`, `ws-shop-q1`, `ws-shop-damsen` — **không có** `ws-demo-b`. Server
từ chối đúng, UI giữ `ws-demo-a`, test chờ `ws-demo-b` nên fail. Lỗi nằm ở UI
(chọn workspace không do server cung cấp), không nằm ở server.

## 1. Mâu thuẫn tài liệu (đã đối chiếu với mã)

| Tài liệu nói | Mã/test nói | Kết luận |
| --- | --- | --- |
| Có `AGENTS.md`, chỉ mô tả catalog + quote draft | Không có `AGENTS.md` trong cây; `src/ops`, `src/founder`, `src/ops/b2b-*` tồn tại đầy đủ | Không tạo lại AGENTS.md; CHECKPOINT/PRODUCT đúng về phạm vi mã |
| PRODUCT: "không có marketplace" và đồng thời liệt kê B2B Marketplace đã xong | `src/ops/b2b-routes.ts`, `b2b-catalog.ts`, 3 màn hình UI, 5 test HTTP + 11 test domain | Sửa PRODUCT: B2B marketplace **tồn tại ở mức demo/pilot nội bộ**, sổ cái escrow là **mô phỏng** (không có ví, không có ngân hàng) |
| CHECKPOINT: 24 E2E | 5 file spec × 2 viewport = 24 case; baseline 22 pass / 2 fail | Giữ số 24 nhưng ghi rõ 2 fail trước khi sửa |
| CHECKPOINT: 2 Worker đã deploy, còn thiếu Access config | RELEASE ghi version id; sandbox không có quyền kiểm tra | Giữ nhãn `live: chưa kiểm chứng lại` |

## 2. Bảng luồng

Cột: **UI** (màn hình gọi được) · **API/domain** (route + hàm) · **D1** (ghi
thật qua migration) · **Phân quyền** (qua `authorize.ts` + kiểm tra bản ghi) ·
**Test** (có test chứng minh) · **Kết luận**.

### 2.1 Nhà vườn (Nursery)

| Luồng | UI | API/domain | D1 | Phân quyền | Test | Kết luận |
| --- | --- | --- | --- | --- | --- | --- |
| Inquiry (yêu cầu ban đầu) | Không có màn riêng; nhập trực tiếp vào bản nháp báo giá + việc cần làm | Không có thực thể `inquiry` (grep `inquir` trong `src/` → chỉ có docs marketing) | Không có bảng | — | — | **Tài liệu hoá**: inquiry = chuỗi báo giá ở trạng thái nháp + follow-up task; không thêm bảng |
| Quote draft → publish revision | `ops-draft`, `ops-chains` | `handleSaveQuoteDraft`, `publishRevision` (`quote-revisions.ts`) | `quote_chains`, `quote_revisions` (0002) | action `quotes.publish`, workspace từ ctx | `ops-routes`, `part-a-gates`, E2E quote-draft-save | OK; revision đã publish bất biến |
| Accept revision → order | `ops-orders` | `acceptRevision` (`transactions.ts`) | `orders` | OK | `ops-transactions` | **Lỗi**: 3 lệnh ghi rời (không batch), `pilot_credit_vnd` lấy từ client → sửa (Phase C) |
| Deposit receipt | `ops-orders` | `createReceipt`, `confirmReceipt`, `reverseReceipt` | `receipts`, `ledger`, `audit_events` | OK | `ops-transactions` | **Lỗi**: `createReceipt` không kiểm `amount_vnd > 0` ở tầng domain; `confirmReceipt` 3 write rời; `changes` không đọc → sửa |
| Delivery | `ops-orders` | `createDelivery`, `updateDeliveryStatus` | `deliveries` | OK | `ops-transactions` | **Lỗi**: kiểm "đủ cọc" là read-then-insert, race → điều kiện SQL |
| Follow-up tasks | `ops-today` | `createFollowUp`, `completeFollowUp` | `follow_ups` | OK | `ops-transactions` | OK |
| Actor id | — | `resolveActorId` fallback về owner đầu tiên / `'id-demo-owner'` | — | **Lỗi**: ghi audit với actor không phải người gọi | — | Sửa: actor luôn từ identity đã xác thực; thiếu → 403 |

### 2.2 Founder

| Luồng | UI | API/domain | D1 | Phân quyền | Test | Kết luận |
| --- | --- | --- | --- | --- | --- | --- |
| Discovery interviews | Founder area | `createOrUpdateInterview`, list | `discovery_interviews` | `founder_admin` qua action | `founder-discovery` | OK |
| Change proposals | Founder area | `createProposal` (evidence + reason) | `change_proposals` | OK | OK | OK |
| Config versions / rollback | Founder area | `publishConfigVersion`, `rollbackConfig` | `config_versions` | OK | OK | OK (rollback tạo version mới trỏ về nguồn) |
| Economics | Founder area | `economics.ts` | — (tính toán) | OK | OK | Tham số seed **không** được gắn nhãn "market-validated" — kiểm tra lại nhãn UI |
| OPC agreements / obligations / receipts / pilot credits | Founder area | `founder/routes.ts` | bảng OPC (0003/0004) | **Lỗi**: `target_workspace_id ?? ctx.workspaceId` không kiểm quyền trên workspace đích | thiếu test | Sửa: phải qua `authorizeWorkspace(target)` (Phase B) |
| Import preview / apply | Founder area | `handlePreviewImportInterviews`, `handleApplyImportInterviews` | `discovery_interviews` | OK | có | **Lỗi**: apply trả về ở lần từ chối đầu tiên → dữ liệu ghi dở → all-or-nothing (Phase E) |
| CSV export | Founder area | `exportInterviewsCsv` | — | OK | có | OK |

### 2.3 B2B / Hub / Settlement

| Luồng | UI | API/domain | D1 | Phân quyền | Test | Kết luận |
| --- | --- | --- | --- | --- | --- | --- |
| Supply lot list/create | `b2b-marketplace` | `handleListLots` → `listSupplyLots` | `supply_lots` | **Lỗi**: SELECT toàn cục, không lọc workspace | `b2b-routes` (fake D1) | Scope theo workspace truy cập được + chia sẻ công khai có định nghĩa (Phase D) |
| Booking create | `b2b-marketplace` | `createBooking` | `bookings`, `supply_lots.available_units`, `escrow_ledger` | OK về role | `b2b-e2e-workflow` | **Lỗi**: batch không kiểm `changes` → oversell; lỗi thô trả 400 |
| Deposit confirm | `b2b-marketplace` | `handleConfirmDeposit` → `confirmDeposit(db, bookingId)` | `bookings.status`, `escrow_ledger` | **Lỗi**: không kiểm workspace của booking | thiếu | Kiểm bên mua/bên bán ∈ workspace truy cập được |
| Hub trip / package | `hub-dispatch` | `handleVerifyHubPackage` → `verifyHubPackage` | `hub_dispatch_trips`, `hub_packages` | **Lỗi**: trip/booking không ràng workspace; CHECK capacity lộ lỗi SQL | thiếu | Điều kiện SQL + 409 tiếng Việt |
| Tạo hub trip | Không có | Không có route (chỉ seed `demo.sql` L376) | — | — | — | Thêm route founder-only (Phase D) |
| Inspection + settlement | `inspection-settlement` | `inspectAndSettleBooking` | `inspection_reports`, `escrow_ledger` | **Lỗi**: cho phép từ `ESCROW_HELD`; ghi `BALANCE_COLLECTED` tại thời điểm nghiệm thu (chưa ai xác nhận thu); `totalCollectedFromBuyerVnd = depositPaid + buyerBalanceRequired` | `b2b-e2e-workflow` | Tách ước tính / phải thu / đã thu xác nhận (migration 0005 `b2b_settlements`) |
| Defect `CARRIER` | — | domain có; HTTP schema chỉ `NONE`/`NURSERY` | — | — | — | Giữ ngoài luồng chạy; ghi blocker quyết định sản phẩm |
| Pilot metrics | `pilot dashboard` | `getPilotDashboardData` | — | **Lỗi**: toàn cục, outlay hard-code 0 → badge "cân bằng" giả | thiếu | Tính từ sổ cái theo workspace truy cập được |
| Agent bridge | palette/HUD | `agent-bridge.ts` | — | **Lỗi**: proposal không gắn workspace, không xoá khi đổi workspace | E2E có HUD | Gắn `workspaceId` + xoá khi đổi |

### 2.4 Nền tảng

| Hạng mục | Hiện trạng | Kết luận |
| --- | --- | --- |
| Chokepoint `authorize.ts` | Mọi quyết định allow/deny đi qua `authorize()`; worker gọi với `findBySubject` | Giữ nguyên; thêm `accessibleWorkspaceIds` tính qua `listBySubject` + `authorize()` |
| `/api/session` | Trả `canSwitchWorkspace` nhưng không trả danh sách; UI toggle cứng | Trả `workspaces: [{workspaceId, role, name}]` **của chính người gọi**; UI `<select>`; đổi chỉ sau khi server xác nhận |
| Mã lỗi | Chỉ `error` tiếng Việt | Thêm `code` ổn định, giữ `error` |
| Idempotency | Không có | Bảng `idempotency_keys` + header `Idempotency-Key` cho POST ghi tiền/booking |
| CI | Không có `.github/workflows/` | Thêm `ci.yml` (Phase G) |
