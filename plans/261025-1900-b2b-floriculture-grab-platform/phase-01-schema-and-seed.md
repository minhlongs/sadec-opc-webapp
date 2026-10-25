# Phase 01 — Database Migration & Seed Data

## Context & Objectives
Tạo migration `migrations/0003_b2b_marketplace_escrow.sql` để mở rộng mô hình dữ liệu D1 SQLite từ 1 nhà vườn sang Sàn B2B Đa Nhà Vườn (20–30 vườn Sa Đéc) kết nối Shop TP.HCM, bao gồm Sổ cái Escrow bất biến và Chuyến xe ghép Hub Sa Đéc.

## Files Owned
- `migrations/0003_b2b_marketplace_escrow.sql` (New)
- `migrations/seed/demo.sql` (Modify)

## Schema Design Requirements
1. `nursery_profiles`: `id`, `workspace_id`, `nursery_name`, `hamlet_area` (Tân Quy Đông, Tân Khánh Đông, Sa Nhiên), `specialties_json`, `verified_status`, `fulfillment_score_bps`, `created_at`.
2. `supply_lots`: `id`, `nursery_workspace_id`, `name`, `mode` (`WEEKLY_CATALOG` / `SEASONAL_PREORDER`), `species`, `pot_diameter_cm`, `height_cm`, `canopy_cm`, `media_proof_url`, `unit_price_vnd`, `deposit_rate_bps` (3000..5000), `moq_units`, `available_units` (`CHECK (available_units >= 0)`), `cut_or_ship_date`, `qr_lot_token`, `status` (`DRAFT`, `PUBLISHED`, `SOLD_OUT`, `ARCHIVED`).
3. `b2b_bookings`: `id`, `booking_code` (e.g. `SDEC-BK-XXXX`), `lot_id`, `nursery_workspace_id`, `buyer_workspace_id`, `quantity`, `unit_price_vnd`, `gross_total_vnd`, `deposit_rate_bps`, `deposit_required_vnd`, `deposit_paid_vnd`, `platform_fee_bps` (200..500), `platform_fee_vnd`, `status` (`BOOKED_PENDING_DEPOSIT`, `ESCROW_HELD`, `HUB_CONSOLIDATED`, `IN_TRANSIT`, `INSPECTED_ACCEPTED`, `INSPECTED_PARTIAL_DEFECT`, `REJECTED_NURSERY_FAULT`, `SETTLED`, `CANCELLED`).
4. `escrow_ledger_entries`: Sổ cái bất biến, `id`, `booking_id`, `entry_type` (`DEPOSIT_HELD`, `BALANCE_COLLECTED`, `DEFECT_DEDUCTION`, `BUYER_REFUND`, `PLATFORM_FEE_RETAINED`, `NURSERY_PAYOUT_RELEASED`), `amount_vnd` (INTEGER VND >= 0), `vietqr_ref`, `note`, `created_at`, `UNIQUE(booking_id, entry_type)`.
5. `hub_dispatch_trips`: `id`, `trip_code` (`TRIP-SDEC-HCM-XXXX`), `truck_plate`, `driver_phone`, `departure_sa_dec_at`, `eta_hcm_at`, `destination_market` (Bình Điền, Đầm Sen, Thủ Đức), `status` (`GATHERING`, `DEPARTED`, `ARRIVED`, `COMPLETED`).
6. `shipment_packages`: `id`, `trip_id`, `booking_id`, `package_qr_token`, `package_label`, `units_count`, `hub_inspection_status` (`PENDING`, `VERIFIED_OK`, `REJECTED`), `buyer_inspection_status` (`PENDING`, `ACCEPTED`, `PARTIAL_DEFECT`, `REJECTED`), `accepted_units`, `defective_units`, `fault_party` (`NONE`, `NURSERY`, `CARRIER`).

## Seed Data Requirements
Cập nhật `migrations/seed/demo.sql` với:
- 3 nhà vườn Sa Đéc đại diện: Vườn Hoa Tư Kiểng (Tân Quy Đông), Vườn Mai Ba Hoàng (Tân Khánh Đông), Vườn Kiểng Lá Út Mười (Sa Nhiên).
- 2 shop hoa TP.HCM đại diện: Shop Hoa Tươi Quận 1, Đại lý Kiểng Lá Chợ Đầm Sen.
- 5 lô hàng mẫu (3 lô `WEEKLY_CATALOG`, 2 lô `SEASONAL_PREORDER`).
- 2 đơn đặt giữ mẫu có cọc VietQR mẫu.
- 1 chuyến xe ghép mẫu Sa Đéc → Chợ Đầm Sen.

## Verification
- Chạy `pnpm db:migrate:local -- --env demo`, `pnpm db:migrate:local -- --env test` và `pnpm db:seed:demo -- --env demo` thành công 100%.
