---
title: "B2B Floriculture Pre-order, Consolidation & Escrow Platform (Sa Đéc → TP.HCM)"
description: "Transform sadec-opc into an escrow-backed B2B floriculture pre-order marketplace connecting Sa Đéc nurseries to TP.HCM shops"
status: completed
priority: P1
effort: 8h
issue: 3
branch: feat/b2b-floriculture-grab-platform
tags: [backend, frontend, database, escrow, vietqr, b2b, pilot]
blockedBy: []
blocks: []
created: 2026-10-25
---

# B2B Floriculture Pre-order, Consolidation & Escrow Platform (Sa Đéc → TP.HCM)

## Overview

Chuyển đổi nền tảng từ mô hình quản lý một nhà vườn đơn lẻ (Part A) thành **Sàn Giao dịch B2B Đặt trước & Bảo chứng Nguồn hàng Hoa Kiểng Việt Nam**, khởi đầu sâu tại tuyến **Vùng cung Sa Đéc (20–30 vườn xác minh) → Vùng cầu TP.HCM (30–50 shop hoa / đại lý sỉ)**.

Mô hình vận hành cốt lõi:
1. **Danh mục 2 chế độ**: Nhập hàng tuần (`WEEKLY_CATALOG`: kiểng lá, cây nội thất) + Sổ đặt trước vụ Tết (`SEASONAL_PREORDER`: cúc mâm xôi, vạn thọ, mai vàng).
2. **Sổ cái Cọc Escrow Bất biến (Integer VND + Basis Points)**: Shop TP.HCM đặt cọc 30–50% qua Dynamic VietQR (`ESCROW_HELD`). Sàn ứng vốn = `0 VND`. Vườn chịu 100% rủi ro chất lượng/quy cách.
3. **Kiểm định kép 2 chặng bằng QR HMAC-SHA256**: Chốt chặn 1 tại Hub Sa Đéc (`HUB_VERIFIED`) trước khi lên xe ghép; Chốt chặn 2 tại TP.HCM (`BUYER_INSPECTED` hoặc `AUTO_ACCEPTED` sau 4h) để nghiệm thu, thu phí sàn 2–5% từ shop và giải ngân cho vườn.
4. **Kế thừa kiến trúc sẵn có**: Tận dụng 100% stack Cloudflare Workers + Hono + D1 SQLite + React 19 + `src/domain/money.ts` (`assertSafeVnd`, `multiplyByBasisPoints`) + `src/security/authorize.ts` đã vượt qua 151 unit tests và 14 Playwright E2E tests.

---

## Phases Roadmap

- [x] **Phase 01 — Database Migration & Seed Data** (`phase-01-schema-and-seed.md`): Schema `0003_b2b_marketplace_escrow.sql` cho hồ sơ vườn, lô hàng 2 chế độ, đơn đặt giữ, sổ cái escrow, chuyến xe ghép hub, kiện hàng QR.
- [x] **Phase 02 — Domain Engines: Escrow Ledger, VietQR EMVCo, Lot QR HMAC** (`phase-02-domain-engines.md`): Lõi tính cọc/phí/khấu trừ 0 VND ứng vốn, VietQR CRC16-CCITT, QR HMAC-SHA256, và đo lường Pilot KPI.
- [x] **Phase 03 — API Routes & Security Chokepoint** (`phase-03-api-and-security.md`): Mở rộng `PERMITTED_ROLES` cho 4 vai trò B2B và xây dựng các route Hono có origin check cho Marketplace, Hub Ops, và Founder Dashboard.
- [x] **Phase 04 — Frontend UI: 5 Subsystems for 390px Mobile & 1440px Desktop** (`phase-04-frontend-ui.md`): Cổng Nhà vườn Sa Đéc, Chợ Sỉ Đặt trước TP.HCM, Bảng Điều phối Hub Sa Đéc, Trạm Nghiệm thu & Đối soát, Bảng Đo lường Pilot.
- [x] **Phase 05 — Verification & End-to-End Test Suite** (`phase-05-verification-and-e2e.md`): TDD integration tests cho 3 kịch bản nghiệm thu (đạt 100%, lỗi một phần, từ chối toàn bộ), E2E test, và chạy `pnpm verify` đạt 0 lỗi.

---

## File Ownership Matrix (Parallel Execution)

| Phase | Files Owned (Strict Boundary) |
|---|---|
| **Phase 01** | `migrations/0003_b2b_marketplace_escrow.sql`, `migrations/seed/demo.sql` |
| **Phase 02** | `src/domain/escrow-ledger.ts`, `src/domain/vietqr.ts`, `src/domain/lot-qr.ts`, `src/domain/pilot-metrics.ts`, `test/escrow-ledger.test.ts`, `test/vietqr.test.ts`, `test/lot-qr.test.ts` |
| **Phase 03** | `src/security/authorize.ts`, `src/worker/api.ts`, `src/worker/index.ts`, `src/ops/b2b-routes.ts`, `src/ops/b2b-catalog.ts`, `test/b2b-routes.test.ts` |
| **Phase 04** | `src/ui/App.tsx`, `src/ui/components/b2b-marketplace.tsx`, `src/ui/components/hub-dispatch.tsx`, `src/ui/components/inspection-settlement.tsx`, `src/ui/components/pilot-dashboard.tsx`, `src/ui/styles.css` |
| **Phase 05** | `test/b2b-e2e-workflow.test.ts`, `e2e/b2b-flow.spec.ts` |

---

## Validation & Red-Team Adjudication Log

- **Validation Status**: PASSED (4/4 structural and architectural invariants verified).
- **Red-Team Findings Applied (2026-10-25)**:
  1. **Tenant-level participant authorization**: `confirm-deposit` and `hub-packages/verify` restricted to `founder_admin` (platform escrow/hub operator), while `inspect-and-settle` checks `auth.workspaceId === booking.buyer_workspace_id || auth.role === 'founder_admin'`, and `lots/create` checks `auth.workspaceId === nursery_workspace_id || auth.role === 'founder_admin'`.
  2. **Pure integer unitPriceVnd in settlement**: `calculateInspectionSettlement` accepts explicit integer `unitPriceVnd` (stored on `b2b_bookings.unit_price_vnd`) and asserts `acceptedUnits + defectiveUnits === totalUnits` and `totalUnits * unitPriceVnd === grossTotalVnd` with zero float division.
  3. **Atomic D1 concurrency & idempotency**: `supply_lots` enforces `CHECK (available_units >= 0)` with atomic `UPDATE supply_lots SET available_units = available_units - ? WHERE id = ? AND available_units >= ?`; `escrow_ledger_entries` enforces `UNIQUE(booking_id, entry_type)` and atomic `db.batch([...])` transitions guarded by `WHERE id = ? AND status = ?`.
  4. **Environment Guard CLI flags**: Database migration and seed commands pass `-- --env demo` / `-- --env test` to satisfy `scripts/require-environment.ts`.

