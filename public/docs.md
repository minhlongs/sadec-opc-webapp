# Sa Đéc Flow — B2B Floriculture Dual-Surface Architecture Docs

## Tổng Quan Kiến Trúc Dual-Surface

Sa Đéc Flow được thiết kế theo mô hình **Dual-Surface (Human UI + AI Agent Native)**:
1. **Mặt giao diện con người (Human Surface):**
   - Giao diện Biophilic Bento 2027 tối ưu cho cả màn hình điện thoại `390px` ngoài nắng vườn Sa Đéc và màn hình `1440px` tại quầy quản lý vựa hoa TP.HCM.
   - Hộp lệnh nhanh `Cmd+K` / `Ctrl+K` điều hướng tức thì.
   - Công tắc chuyển đổi xem dữ liệu Human ↔ Agent JSON-LD.
   - Agent Proposal HUD: Khối nổi hiển thị đề xuất từ AI Agent để người dùng bấm nút duyệt VietQR, đảm bảo nguyên tắc Zero Auto-Spend.

2. **Mặt giao tiếp tác tử AI (Agent Surface):**
   - Đơn nguồn chiếu dữ liệu (Single Source of Truth): Từ D1 DB chiếu ra `Schema.org` JSON-LD, `llms.txt`, `llms-full.txt`, `docs.md`, và semantic HTML.
   - WebMCP Browser Tools: AI Agent hoạt động ngay trong tab trình duyệt thông qua `window.__SADEC_AGENT_BRIDGE__` và `navigator.modelContext`.
   - Kiểm soát xung đột lạc quan: Dùng `revision = computeLotRevision(lot)` chống tình trạng đặt trùng khi nhiều Agent cùng săn hàng sỉ.

## Danh Sách API Endpoints

### 1. Public Discovery Endpoints (Không Cần Xác Thực)
- `GET /api/public/catalog` — Trả về danh sách lô hoa kiểng sỉ (`PublicLotProjection[]`), hỗ trợ query `?mode=WEEKLY_CATALOG|SEASONAL_PREORDER`.
- `GET /api/schema` — Trả về Schema.org JSON-LD Catalog Graph & WebMCP Agent JSON Schemas.
- `GET /api/discover` — Trả về HTML5 ngữ nghĩa đầy đủ cho các bot AI thu thập thông tin.
- `GET /discover` — Trang hiển thị bảng danh mục tĩnh thân thiện với SEO & AEO.

### 2. B2B Booking & Ops Endpoints (Yêu Cầu Xác Thực Cloudflare Access)
- `GET /api/b2b/lots` — Danh sách lô hoa đầy đủ quyền quản trị.
- `POST /api/b2b/lots/create` — Nhà vườn đăng ký lô hoa mới.
- `POST /api/b2b/bookings/create` — Tạo đơn đặt giữ (hỗ trợ `expected_revision`).
- `GET /api/b2b/bookings` — Danh sách đơn đặt của nhà vườn hoặc người mua.
- `POST /api/b2b/ledger/record-deposit` — Ghi nhận cọc chuyển khoản VietQR.
- `POST /api/b2b/shipments/verify-hub` — Hub Sa Đéc nghiệm thu và dán QR kiện.
- `POST /api/b2b/shipments/inspect-settlement` — Shop TP.HCM nghiệm thu và chốt quyết toán.

## Cơ Chế Bảo Chứng Cọc VietQR Escrow (0đ Ứng Vốn)

```text
[Shop TP.HCM] --(1) Đặt giữ & Quét VietQR Cọc 30-50%--> [Tài Khoản Ký Quỹ Escrow]
                                                                |
[Nhà Vườn Sa Đéc] --(2) Giao hàng tới Hub Sa Đéc <---------------+ (Giữ an toàn, Sàn 0đ ứng vốn)
         |
    (Kiểm định Chốt 1: Quy cách nụ, tán, dán QR Kiện)
         |
[Xe Tải Lạnh Cross-Docking] ---> [Chợ Sỉ TP.HCM]
                                       |
    (Kiểm định Chốt 2: Shop quét QR & Đối soát số lượng)
                                       |
[Shop TP.HCM] --(3) Quét VietQR Tất Toán 50-70%--------> [Tài Khoản Ký Quỹ Escrow]
                                                                |
                                                 (4) Giải ngân tự động:
                                                 - Nhà vườn nhận đủ tiền hàng đạt chuẩn
                                                 - Sàn giữ lại 2-5% phí vận hành
                                                 - Hoàn tiền cọc nếu có lỗi từ nhà vườn
```

## Hướng Dẫn Tích Hợp WebMCP Cho Agent

```javascript
if (window.__SADEC_AGENT_BRIDGE__) {
  const bridge = window.__SADEC_AGENT_BRIDGE__;

  // 1. Tìm các lô cúc mâm xôi Tết
  const lots = await bridge.tools.listSupplyLots({ mode: 'SEASONAL_PREORDER' });

  // 2. Lấy báo giá mẫu
  const quote = await bridge.tools.quoteBooking({
    quantity: lots[0].moq_units,
    unitPriceVnd: lots[0].unit_price_vnd,
    depositRateBps: lots[0].deposit_rate_bps,
    platformFeeBps: 300,
  });

  // 3. Đề xuất đặt giữ (Human-in-the-loop duyệt)
  await bridge.tools.proposeBooking({
    lotId: lots[0].id,
    quantity: lots[0].moq_units,
    expectedRevision: lots[0].revision,
    buyerShopName: 'Shop Hoa Tươi Quận 1',
    buyerContactPhone: '0901234567',
    destinationMarket: 'Chợ Hồ Thị Kỷ',
    note: 'Giao sáng sớm trước 05:00',
  });
}
```
