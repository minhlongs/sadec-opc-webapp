# Phase 02 — Domain Engines: Escrow Ledger, VietQR EMVCo, Lot QR HMAC

## Context & Objectives
Xây dựng toàn bộ các module tính toán cốt lõi trong `src/domain/` sử dụng integer VND từ `src/domain/money.ts`, không dùng số thực (`float`), đảm bảo số dư ứng vốn của sàn luôn bằng `0 VND` ở mọi kịch bản nghiệm thu.

## Files Owned
- `src/domain/escrow-ledger.ts` (New)
- `src/domain/vietqr.ts` (New)
- `src/domain/lot-qr.ts` (New)
- `src/domain/pilot-metrics.ts` (New)
- `test/escrow-ledger.test.ts` (New)
- `test/vietqr.test.ts` (New)
- `test/lot-qr.test.ts` (New)

## Implementation Details
1. **`src/domain/escrow-ledger.ts`**:
   - `calculateBookingQuote({ quantity, unitPriceVnd, depositRateBps, platformFeeBps })`: trả về `grossTotalVnd`, `depositRequiredVnd`, `platformFeeVnd`, `estimatedBuyerTotalVnd`.
   - `calculateInspectionSettlement({ unitPriceVnd, grossTotalVnd, depositPaidVnd, platformFeeBps, totalUnits, acceptedUnits, defectiveUnits, faultParty })`:
     - Kiểm tra bất biến đầu vào: `acceptedUnits + defectiveUnits === totalUnits` và `totalUnits * unitPriceVnd === grossTotalVnd` (thuần integer VND, không chia float).
     - Nếu `acceptedUnits === totalUnits` (Đạt 100%): vườn nhận `grossTotalVnd`, phí sàn = `multiplyByBasisPoints(grossTotalVnd, platformFeeBps)`, shop trả thêm `grossTotalVnd - depositPaidVnd + platformFeeVnd`, hoàn cọc = `0`.
     - Nếu `faultParty === 'NURSERY'` và `acceptedUnits === 0` (Từ chối toàn bộ do lỗi vườn): hoàn 100% `depositPaidVnd` cho shop, vườn nhận `0 VND`, phí sàn = `0 VND`, shop trả thêm = `0 VND`.
     - Nếu `faultParty === 'NURSERY'` và `0 < acceptedUnits < totalUnits` (Lỗi một phần do vườn): giá trị hàng đạt `acceptedValueVnd = acceptedUnits * unitPriceVnd`, phí sàn tính trên `acceptedValueVnd`, nếu `depositPaidVnd <= acceptedValueVnd + platformFeeVnd` thì shop trả phần chênh lệch còn thiếu; nếu cọc đã đóng lớn hơn tổng phải trả thì hoàn lại phần dư cho shop từ cọc. Vườn nhận đúng `acceptedValueVnd`.
   - `assertZeroPlatformOutlay(settlement)`: kiểm tra `platformOutlayVnd === 0` và `totalCollectedFromBuyerVnd === nurseryPayoutVnd + buyerRefundVnd + platformFeeRetainedVnd`.
2. **`src/domain/vietqr.ts`**:
   - Chuẩn EMVCo ISO/IEC 18004 NAPAS 247 + hàm `crc16Ccitt(payload)` (`0x1021`, init `0xFFFF`).
   - Sinh chuỗi VietQR động cho 2 pha: `DEP` (Đặt cọc 30–50%) và `BAL` (Tất toán sau nghiệm thu).
3. **`src/domain/lot-qr.ts`**:
   - Dùng `crypto.subtle` (`HMAC-SHA256`) để ký và kiểm tra mã QR định danh lô hàng & kiện hàng (`signLotQrToken`, `verifyLotQrToken`).
4. **`src/domain/pilot-metrics.ts`**:
   - Tính toán 4 chỉ số Pilot (số vườn xác minh active, số shop active, số đơn hoàn tất/tháng, tỷ lệ đặt lại tháng thứ 2 bằng basis points).

## Verification
- Chạy `pnpm vitest run test/escrow-ledger.test.ts test/vietqr.test.ts test/lot-qr.test.ts` pass 100%.
