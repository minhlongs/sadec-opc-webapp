# Phase 04 — Frontend UI: 5 Subsystems for 390px Mobile & 1440px Desktop

## Context & Objectives
Xây dựng giao diện Web/PWA bằng tiếng Việt tối ưu cho cả màn hình điện thoại di động `390px` (nhà vườn thao tác tại liếp hoa, tài xế/hub quét QR lúc xếp hàng, shop kiểm hàng lúc 5h sáng tại chợ đầu mối) và máy tính `1440px` (bàn điều phối Hub và dashboard sáng lập).

## Files Owned
- `src/ui/App.tsx` (Modify)
- `src/ui/components/b2b-marketplace.tsx` (New)
- `src/ui/components/hub-dispatch.tsx` (New)
- `src/ui/components/inspection-settlement.tsx` (New)
- `src/ui/components/pilot-dashboard.tsx` (New)
- `src/ui/styles.css` (Modify)

## UI Subsystems
1. **Thanh điều hướng phân khu B2B**:
   - `Chợ Sỉ Hoa Kiểng (Shop TP.HCM)`
   - `Cổng Nhà Vườn (Sa Đéc)`
   - `Điều Phối Hub (Sa Đéc → TP.HCM)`
   - `Nghiệm Thu & Đối Soát (Shop TP.HCM)`
   - `Chỉ Số Pilot 3–6 Tháng (Sáng Lập)`
2. **Chợ Sỉ Đặt Trước TP.HCM & VietQR Escrow (`b2b-marketplace.tsx`)**:
   - Tabs: `Hàng Nhập Hàng Tuần` (kiểng lá, cây nội thất) và `Sổ Đặt Trước Tết` (cúc mâm xôi, vạn thọ).
   - Thẻ lô hàng: Ảnh/video thực tế tại vườn, thẻ uy tín vườn Sa Đéc, MOQ, ngày cắt/xuất bến, đơn giá integer VND, tỷ lệ cọc (30–50%).
   - Modal đặt giữ lô & hiển thị mã VietQR động để chuyển khoản cọc (`SDEC DEP {code}`).
3. **Cổng Nhà Vườn Sa Đéc (`b2b-marketplace.tsx`)**:
   - Form đăng lô mới (chọn chế độ Tuần / Tết, nhập chiều cao, đường kính chậu, tán lá, ảnh cam kết, tỷ lệ cọc).
   - Danh sách lô đang bán + Mã QR HMAC của từng lô.
   - Thống kê cọc đang được sàn giữ tạm (`ESCROW_HELD`).
4. **Bảng Điều Phối Gom Hàng Hub Sa Đéc (`hub-dispatch.tsx`)**:
   - Bảng cross-docking gom chuyến xe ghép đêm Sa Đéc → TP.HCM.
   - Nút quét/xác nhận quy cách kiện hàng tại Hub Sa Đéc (`HUB_VERIFIED`).
5. **Trạm Nghiệm Thu & Đối Soát Sổ Cái tại TP.HCM (`inspection-settlement.tsx`)**:
   - Quét mã QR kiện hàng → hiển thị đối chiếu thông số cam kết của vườn.
   - 3 lựa chọn nghiệm thu: `Đạt 100%`, `Báo lỗi quy cách một phần do vườn` (nhập số cây lỗi), `Từ chối toàn bộ do lỗi vườn`.
   - Bảng tính tự động minh bạch: số tiền cọc đã giữ, số tiền khấu trừ vào phần nhà vườn, phí sàn 2–5%, số tiền shop cần trả thêm (kèm mã VietQR tất toán) hoặc số tiền hoàn lại shop.
6. **Bảng Chỉ Số Pilot & Sổ Cái Bất Biến (`pilot-dashboard.tsx`)**:
   - 4 thẻ KPI Pilot: Vườn Sa Đéc xác minh (20–30), Shop TP.HCM hoạt động (30–50), Đơn hoàn tất/tháng (~100), Tỷ lệ đặt lại tháng 2 (>40%).
   - Trạng thái bất biến sổ cái: Sàn ứng trước = `0 VND`, Số đơn lệch đối soát = `0`.

## Verification
- Chạy `pnpm build` không lỗi, bundle CSS/TSX clean.
