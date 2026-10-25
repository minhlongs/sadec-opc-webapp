# Phase 05 — Verification & End-to-End Test Suite

## Context & Objectives
Kiểm thử toàn diện luồng B2B từ lúc Nhà vườn Sa Đéc đăng lô → Shop TP.HCM đặt cọc VietQR → Hub Sa Đéc gom chuyến & cấp QR → Shop TP.HCM quét QR nghiệm thu (3 kịch bản) → Quyết toán sổ cái bất biến. Bảo toàn 100% các bài test hiện hữu của Part A.

## Files Owned
- `test/b2b-e2e-workflow.test.ts` (New)
- `e2e/b2b-flow.spec.ts` (New)

## Test Cases Required
1. **Scenario 1 — Nghiệm thu Đạt 100%**:
   - Lô 10,000,000 VND (50 chậu × 200,000 VND), cọc 40% (`4,000,000 VND` `ESCROW_HELD`), phí sàn 3% (`300,000 VND`).
   - Sau `HUB_VERIFIED` và `INSPECTED_ACCEPTED`, shop trả thêm `6,300,000 VND`, vườn nhận `10,000,000 VND`, sàn thu `300,000 VND`, `platformOutlayVnd === 0`.
2. **Scenario 2 — Nghiệm thu Lỗi một phần do vườn (20% hàng sai quy cách)**:
   - 10/50 chậu bị lỗi quy cách do vườn (`faultParty = 'NURSERY'`), 40 chậu đạt (`8,000,000 VND`).
   - Phí sàn 3% tính trên giá trị hàng đạt thực tế = `240,000 VND`.
   - Shop chỉ trả thêm `4,240,000 VND`, nhà vườn bị khấu trừ `2,000,000 VND` và thực nhận `8,000,000 VND`, `platformOutlayVnd === 0`.
3. **Scenario 3 — Từ chối toàn bộ lô do lỗi vườn**:
   - 0/50 chậu đạt (`faultParty = 'NURSERY'`).
   - Hoàn 100% cọc `4,000,000 VND` cho shop, vườn nhận `0 VND`, phí sàn = `0 VND`, `platformOutlayVnd === 0`.
4. **SQL Invariant Check**:
   - Mọi đơn ở trạng thái `SETTLED` đều có `SUM(DEPOSIT_HELD + BALANCE_COLLECTED) === SUM(NURSERY_PAYOUT_RELEASED + BUYER_REFUND + PLATFORM_FEE_RETAINED)`.

## Verification
- Chạy `pnpm verify` (`typecheck` + `test` + `build`) pass 100% với `>= 180` tests.
