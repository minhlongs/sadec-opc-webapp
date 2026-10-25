-- Demo seed for the demo database, and nothing else.
--
-- §14 asks for enough data to demonstrate: two workspaces, twelve to twenty
-- products, customers and inquiries, quotes in several states, orders and
-- deposits, and three to five sample interviews. §6 forbids copying demo rows
-- into the pilot environment, and §5 requires every screen and every printout
-- from the demo environment to carry the DEMO label — so the names below say
-- DEMO out loud, and contact details use the example.test domain that never
-- routes to a real mailbox.
--
-- Idempotent by construction: every insert is `INSERT OR IGNORE` against a
-- stable id, so re-running the seed keeps whatever was edited during a demo
-- rather than overwriting it. A demo reset, when one is needed, is a separate
-- guarded command and never something this file does on its own.

INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES
  ('ws-demo-a',  'DEMO — Vườn A',  '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('ws-demo-b',  'DEMO — Vườn B',  '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z');

-- Identities for the three roles §6 defines. All of them are demo identities:
-- the pilot environment boots its founder from the configured identity, not from
-- this file.
INSERT OR IGNORE INTO identities (id, access_sub, email, display_name, created_at) VALUES
  ('id-demo-admin',     'demo:sub:admin',     'admin@example.test',     'DEMO — Founder',   '2026-10-23T02:00:00.000Z'),
  ('id-demo-owner',     'demo:sub:owner',     'owner@example.test',     'DEMO — Chủ vườn',  '2026-10-23T02:00:00.000Z'),
  ('id-demo-operator',  'demo:sub:operator',  'operator@example.test',  'DEMO — Nhân viên', '2026-10-23T02:00:00.000Z');

-- The founder administers both workspaces, and each workspace has its own owner
-- and operator, so a demo of §6's role boundaries has real rows to work against.
INSERT OR IGNORE INTO memberships (id, identity_id, workspace_id, role, granted_by, granted_at) VALUES
  ('mb-demo-admin-a', 'id-demo-admin',    'ws-demo-a', 'founder_admin',      'id-demo-admin', '2026-10-23T02:00:00.000Z'),
  ('mb-demo-admin-b', 'id-demo-admin',    'ws-demo-b', 'founder_admin',      'id-demo-admin', '2026-10-23T02:00:00.000Z'),
  ('mb-demo-owner-a', 'id-demo-owner',    'ws-demo-a', 'workspace_owner',    'id-demo-admin', '2026-10-23T02:00:00.000Z'),
  ('mb-demo-op-a',    'id-demo-operator', 'ws-demo-a', 'workspace_operator', 'id-demo-admin', '2026-10-23T02:00:00.000Z'),
  ('mb-demo-owner-b', 'id-demo-owner',    'ws-demo-b', 'workspace_owner',    'id-demo-admin', '2026-10-23T02:00:00.000Z');

-- One audit row per bootstrap, so the audit trail is visibly populated rather
-- than empty when a demo reaches §6's founder-access requirement.
INSERT OR IGNORE INTO audit_events (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at) VALUES
  ('ae-demo-seed-a', 'ws-demo-a', 'id-demo-admin', 'membership.granted', 'membership', 'mb-demo-owner-a', 'DEMO seed: owner granted for workspace A', '2026-10-23T02:00:00.000Z'),
  ('ae-demo-seed-b', 'ws-demo-b', 'id-demo-admin', 'membership.granted', 'membership', 'mb-demo-owner-b', 'DEMO seed: owner granted for workspace B', '2026-10-23T02:00:00.000Z');

-- Business tables — products, customers, quotes, orders, receipts, delivery,
-- interviews, observations, proposals and config versions — arrive with the
-- phases that own them. The seed is extended beside each one, so a phase never
-- seeds a table it did not create.

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------

-- Fifteen items for workspace A: the count §14 asks for, so a demo of search and
-- filtering runs against a list that behaves like a real catalog rather than three
-- rows. Species, size class and grade are the three axes a nursery actually quotes
-- on, so every one of them is populated on most rows — a row with all three blank
-- would be a placeholder, and §4 forbids building the feel of a product out of
-- empty forms.
--
-- Prices are integers in dong, in the range a wholesale plant buyer pays. They are
-- assumptions like every other starting figure in this seed, and the DEMO label on
-- screen is what keeps them from being read as a price list.
INSERT OR IGNORE INTO products (id, workspace_id, name, species, size_class, grade, price_vnd, unit, stock_note, is_active, created_at, updated_at) VALUES
  ('pd-a-01', 'ws-demo-a', 'Cau vàng',        'Cau vàng',   'S',  'A',  180000,  'chậu', 'Còn 120 chậu', 1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-02', 'ws-demo-a', 'Cau vàng',        'Cau vàng',   'M',  'A',  350000,  'chậu', 'Còn 80 chậu',  1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-03', 'ws-demo-a', 'Cau vàng',        'Cau vàng',   'L',  'A',  650000,  'chậu', 'Còn 40 chậu',  1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-04', 'ws-demo-a', 'Cau vàng',        'Cau vàng',   'M',  'B',  280000,  'chậu', 'Còn 60 chậu',  1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-05', 'ws-demo-a', 'Lan Ý',           'Lan Ý',      'M',  'A',  450000,  'chậu', 'Theo mùa',     1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-06', 'ws-demo-a', 'Lan Ý',           'Lan Ý',      'L',  'A',  750000,  'chậu', 'Theo mùa',     1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-07', 'ws-demo-a', 'Trúc cảnh',       'Trúc',       'M',  'A',  520000,  'chậu', 'Còn 25 chậu',  1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-08', 'ws-demo-a', 'Sanh Nam Bộ',     'Sanh',       'S',  'A',  95000,   'chậu', 'Còn 300 chậu', 1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-09', 'ws-demo-a', 'Sanh Nam Bộ',     'Sanh',       'M',  'A',  165000,  'chậu', 'Còn 180 chậu', 1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-10', 'ws-demo-a', 'Cẩm tú cầu',      'Cẩm tú cầu','M',  'A',  260000,  'chậu', 'Còn 90 chậu',  1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-11', 'ws-demo-a', 'Hoa mãn đền hồng','Mãn đền',    'M',  'A',  320000,  'chậu', 'Còn 45 chậu',  1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-12', 'ws-demo-a', 'Lộc vừng',        'Lộc vừng',   'L',  'A',  890000,  'cây',  'Đặt trước 5 ngày', 1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-13', 'ws-demo-a', 'Sung cảnh',       'Sung',       'M',  'A',  480000,  'cây',  'Còn 12 cây',   1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-14', 'ws-demo-a', 'Mai chiếu thủy',  'Mai chiếu thủy', 'M', 'A', 380000, 'chậu', 'Còn 30 chậu',  1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-a-15', 'ws-demo-a', 'Cau vàng',        'Cau vàng',   'S',  'B',  140000,  'chậu', 'Còn 150 chậu', 1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z');

-- Four products for workspace B, so a demo of §6's workspace boundary can show
-- an identity with membership in A seeing a different list from one in B. A
-- product belonging to another workspace is not a permission error the user can
-- see; it is simply absent, which is the shape the boundary should have.
INSERT OR IGNORE INTO products (id, workspace_id, name, species, size_class, grade, price_vnd, unit, stock_note, is_active, created_at, updated_at) VALUES
  ('pd-b-01', 'ws-demo-b', 'Cau vàng',    'Cau vàng', 'M', 'A', 330000, 'chậu', 'Còn 50 chậu',  1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-b-02', 'ws-demo-b', 'Trúc cảnh',   'Trúc',     'L', 'A', 680000, 'chậu', 'Còn 15 chậu',  1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-b-03', 'ws-demo-b', 'Sanh Nam Bộ', 'Sanh',     'S', 'A', 98000,  'chậu', 'Còn 200 chậu', 1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('pd-b-04', 'ws-demo-b', 'Lan Ý',       'Lan Ý',    'M', 'A', 430000, 'chậu', 'Theo mùa',     1, '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z');

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

-- Six customers for A, one for B. Contact details use example.test, which is the
-- reserved domain that never routes to a real mailbox — a demo seed that carries a
-- real phone number is how real contact data ends up in a repository.
INSERT OR IGNORE INTO customers (id, workspace_id, name, contact_name, phone, address, note, created_at, updated_at) VALUES
  ('cu-a-01', 'ws-demo-a', 'Công ty Cây xanh Miền Tây', 'Chị Hương', '0900000001', 'Đường Nguyễn Sinh Sắc, Sa Đéc', 'Mua theo mùa, ưu tiên giao sáng sớm.', '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('cu-a-02', 'ws-demo-a', 'Khu du lịch sinh thái X',   'Anh Tới',   '0900000002', 'Huyện Cao Lãnh',                 'Cần báo giá cho giai đoạn 2.',     '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('cu-a-03', 'ws-demo-a', 'Chợ đầu mối Đồng Tháp',      'Bà Lan',    '0900000003', 'TP Cao Lãnh',                    'Lấy buổi, giá sỉ.',                '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('cu-a-04', 'ws-demo-a', 'Vườn ươm Đồng Nai',          'Anh Minh',  '0900000004', 'Biên Hòa',                       'Đặt cây công trình số lượng lớn.', '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('cu-a-05', 'ws-demo-a', 'Resort ven sông',            'Chị Ngọc',  '0900000005', 'Huyện Lấp Vò',                   'Ưu tiên cây nội thất.',            '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('cu-a-06', 'ws-demo-a', 'Cá nhân — anh Kiên',         'Anh Kiên',  '0900000006', 'Sa Đéc',                         'Khách lẻ, hay hỏi lại giá.',      '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('cu-b-01', 'ws-demo-b', 'Công ty Cảnh quan ĐBSCL',    'Chị Trang', '0900000007', 'Cần Thơ',                        'Hợp đồng theo năm.',              '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z');

-- Quote drafts arrive with the phase that owns them. One live draft is enough to
-- show the shape; a demo of several quotes in several states is phase 2's work,
-- because the statuses they demonstrate do not exist yet.

-- ---------------------------------------------------------------------------
-- B2B Floriculture Marketplace Seed (Sa Đéc Supply Hub → TP.HCM Demand)
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES
  ('ws-demo-c', 'DEMO — Vườn Kiểng Lá Út Mười', '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('ws-shop-q1', 'DEMO — Shop Hoa Tươi Quận 1', '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z'),
  ('ws-shop-damsen', 'DEMO — Đại Lý Sỉ Chợ Đầm Sen', '2026-10-23T02:00:00.000Z', '2026-10-23T02:00:00.000Z');

INSERT OR IGNORE INTO memberships (id, identity_id, workspace_id, role, granted_by, granted_at) VALUES
  ('mb-demo-admin-c',      'id-demo-admin',    'ws-demo-c',      'founder_admin',      'id-demo-admin', '2026-10-23T02:00:00.000Z'),
  ('mb-demo-admin-q1',     'id-demo-admin',    'ws-shop-q1',     'founder_admin',      'id-demo-admin', '2026-10-23T02:00:00.000Z'),
  ('mb-demo-admin-damsen', 'id-demo-admin',    'ws-shop-damsen', 'founder_admin',      'id-demo-admin', '2026-10-23T02:00:00.000Z'),
  ('mb-demo-owner-c',      'id-demo-owner',    'ws-demo-c',      'workspace_owner',    'id-demo-admin', '2026-10-23T02:00:00.000Z'),
  ('mb-demo-op-q1',        'id-demo-operator', 'ws-shop-q1',     'workspace_operator', 'id-demo-admin', '2026-10-23T02:00:00.000Z'),
  ('mb-demo-op-damsen',    'id-demo-operator', 'ws-shop-damsen', 'workspace_operator', 'id-demo-admin', '2026-10-23T02:00:00.000Z');

INSERT OR IGNORE INTO nursery_profiles (
  id, workspace_id, nursery_name, hamlet_area, owner_name, phone,
  specialties_json, verified_status, fulfillment_score_bps, created_at, updated_at
) VALUES
  (
    'np-sadec-01',
    'ws-demo-a',
    'DEMO — Vườn Hoa Tư Kiểng (Tân Quy Đông)',
    'Tân Quy Đông',
    'Chú Tư Kiểng',
    '0900000101',
    '["Cúc mâm xôi","Vạn thọ Pháp","Hoa giấy ngũ sắc"]',
    'VERIFIED',
    9850,
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  ),
  (
    'np-sadec-02',
    'ws-demo-b',
    'DEMO — Vườn Mai Ba Hoàng (Tân Khánh Đông)',
    'Tân Khánh Đông',
    'Anh Ba Hoàng',
    '0900000102',
    '["Mai vàng giảo Thủ Đức","Mai chiếu thủy","Lộc vừng"]',
    'VERIFIED',
    9720,
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  ),
  (
    'np-sadec-03',
    'ws-demo-c',
    'DEMO — Vườn Kiểng Lá Út Mười (Sa Nhiên)',
    'Sa Nhiên',
    'Cô Út Mười',
    '0900000103',
    '["Monstera Thai Constellation","Trầu bà Nam Mỹ","Cau vàng nội thất"]',
    'VERIFIED',
    9910,
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  );

INSERT OR IGNORE INTO supply_lots (
  id, lot_code, nursery_workspace_id, name, mode, species, grade,
  pot_diameter_cm, height_cm, canopy_cm, bud_specification, media_proof_url,
  unit, unit_price_vnd, deposit_rate_bps, moq_units, total_units, available_units,
  cut_or_ship_date, qr_lot_token, status, created_at, updated_at
) VALUES
  (
    'lot-w-01',
    'SDEC-LOT-W01',
    'ws-demo-c',
    'Monstera Thai Constellation (Kiểng lá xuất tuần)',
    'WEEKLY_CATALOG',
    'Monstera deliciosa',
    'A',
    25,
    55,
    45,
    '4-5 lá xẻ đều, mảng var kem rõ >= 30%, rễ khỏe ấm chậu',
    'https://images.example.test/sadec/lot-w-01.jpg',
    'chậu',
    220000,
    3000,
    10,
    120,
    90,
    '2026-10-28',
    'SDEC-QR-LOT-W01.demo-hmac-signature',
    'PUBLISHED',
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  ),
  (
    'lot-w-02',
    'SDEC-LOT-W02',
    'ws-demo-a',
    'Cau vàng nội thất chậu sứ (Lô hàng tuần)',
    'WEEKLY_CATALOG',
    'Chrysalidocarpus lutescens',
    'A',
    30,
    110,
    70,
    'Bụi 7-9 thân vàng óng, lá xanh mướt không cháy đầu lá',
    'https://images.example.test/sadec/lot-w-02.jpg',
    'chậu',
    180000,
    3000,
    15,
    150,
    150,
    '2026-10-29',
    'SDEC-QR-LOT-W02.demo-hmac-signature',
    'PUBLISHED',
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  ),
  (
    'lot-w-03',
    'SDEC-LOT-W03',
    'ws-demo-c',
    'Lan Ý đại bông trắng (Nhập sỉ hàng tuần)',
    'WEEKLY_CATALOG',
    'Spathiphyllum Wallisii',
    'A',
    22,
    60,
    50,
    'Tối thiểu 4 bông mở + 2 nụ lớn mỗi chậu, bầu xơ dừa sạch',
    'https://images.example.test/sadec/lot-w-03.jpg',
    'chậu',
    150000,
    3500,
    20,
    200,
    160,
    '2026-10-30',
    'SDEC-QR-LOT-W03.demo-hmac-signature',
    'PUBLISHED',
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  ),
  (
    'lot-tet-01',
    'SDEC-LOT-TET01',
    'ws-demo-a',
    'Cúc mâm xôi đại Hàn Quốc (Sổ đặt trước Tết 2027)',
    'SEASONAL_PREORDER',
    'Chrysanthemum morifolium',
    'A+',
    40,
    65,
    100,
    'Tán tròn mâm xôi 100cm, nụ kim đều 100%, nở rộ đúng 27-29 Tết',
    'https://images.example.test/sadec/lot-tet-01.jpg',
    'cặp',
    320000,
    4000,
    25,
    500,
    450,
    '2027-01-28',
    'SDEC-QR-LOT-TET01.demo-hmac-signature',
    'PUBLISHED',
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  ),
  (
    'lot-tet-02',
    'SDEC-LOT-TET02',
    'ws-demo-b',
    'Mai vàng giảo Thủ Đức ghép 3 mùa (Đặt trước Tết)',
    'SEASONAL_PREORDER',
    'Ochna integerrima',
    'A',
    45,
    135,
    90,
    'Hoành gốc 18-22cm, bông 8-12 cánh, mắt nụ dày đã xử lý phân hóa mầm hoa',
    'https://images.example.test/sadec/lot-tet-02.jpg',
    'chậu',
    850000,
    5000,
    10,
    100,
    100,
    '2027-01-30',
    'SDEC-QR-LOT-TET02.demo-hmac-signature',
    'PUBLISHED',
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  );

INSERT OR IGNORE INTO b2b_bookings (
  id, booking_code, lot_id, nursery_workspace_id, buyer_workspace_id,
  buyer_shop_name, buyer_contact_phone, destination_market,
  quantity, unit_price_vnd, gross_total_vnd, deposit_rate_bps,
  deposit_required_vnd, deposit_paid_vnd, platform_fee_bps, platform_fee_vnd,
  status, note, created_at, updated_at
) VALUES
  (
    'bk-demo-01',
    'SDEC-BK-1001',
    'lot-w-01',
    'ws-demo-c',
    'ws-demo-a',
    'DEMO — Shop Hoa Tươi Quận 1',
    '0900000201',
    'Chợ Hồ Thị Kỷ (Quận 10, TP.HCM)',
    30,
    220000,
    6600000,
    3000,
    1980000,
    1980000,
    300,
    198000,
    'HUB_CONSOLIDATED',
    'Giao chuyến đêm về sạp B12 trước 04:30 sáng.',
    '2026-10-24T08:00:00.000Z',
    '2026-10-24T09:00:00.000Z'
  ),
  (
    'bk-demo-02',
    'SDEC-BK-1002',
    'lot-tet-01',
    'ws-demo-a',
    'ws-demo-a',
    'DEMO — Đại Lý Sỉ Chợ Đầm Sen',
    '0900000202',
    'Chợ Hoa Đầm Sen (Quận 11, TP.HCM)',
    50,
    320000,
    16000000,
    4000,
    6400000,
    6400000,
    300,
    480000,
    'ESCROW_HELD',
    'Đặt giữ lô Tết sớm, yêu cầu cập nhật ảnh nụ ngày 15 Chạp.',
    '2026-10-24T10:00:00.000Z',
    '2026-10-24T10:30:00.000Z'
  );

INSERT OR IGNORE INTO escrow_ledger_entries (
  id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at
) VALUES
  (
    'led-demo-01',
    'bk-demo-01',
    'DEPOSIT_HELD',
    1980000,
    'SDEC DEP SDEC-BK-1001',
    'Đã nhận cọc 30% qua VietQR bảo chứng tại sàn',
    '2026-10-24T08:15:00.000Z'
  ),
  (
    'led-demo-02',
    'bk-demo-02',
    'DEPOSIT_HELD',
    6400000,
    'SDEC DEP SDEC-BK-1002',
    'Đã nhận cọc 40% giữ lô Tết qua VietQR bảo chứng',
    '2026-10-24T10:20:00.000Z'
  );

INSERT OR IGNORE INTO hub_dispatch_trips (
  id, trip_code, truck_plate, driver_name, driver_phone,
  departure_sa_dec_at, eta_hcm_at, destination_market,
  capacity_units, loaded_units, status, created_at, updated_at
) VALUES
  (
    'trip-demo-01',
    'TRIP-SDEC-HCM-01',
    '66C-189.45',
    'Anh Tài (Tài xế tuyến đêm Sa Đéc)',
    '0900000301',
    '2026-10-25T21:30:00.000Z',
    '2026-10-26T03:30:00.000Z',
    'Chợ Đầm Sen & Chợ Hồ Thị Kỷ (TP.HCM)',
    250,
    30,
    'GATHERING',
    '2026-10-24T07:00:00.000Z',
    '2026-10-24T09:00:00.000Z'
  );

INSERT OR IGNORE INTO shipment_packages (
  id, trip_id, booking_id, package_qr_token, package_label, units_count,
  hub_inspection_status, hub_verified_at, hub_note,
  buyer_inspection_status, buyer_inspected_at,
  accepted_units, defective_units, fault_party, created_at, updated_at
) VALUES
  (
    'pkg-demo-01',
    'trip-demo-01',
    'bk-demo-01',
    'SDEC-PKG-BK1001.demo-hmac-signature',
    'Kiện #01 — 30 chậu Monstera Thai (Giao Sạp B12 Hồ Thị Kỷ)',
    30,
    'VERIFIED_OK',
    '2026-10-24T09:00:00.000Z',
    'Đã kiểm 30/30 chậu đạt chuẩn chiều cao 55cm, đóng khung sắt chống dập lá.',
    'PENDING',
    NULL,
    0,
    0,
    'NONE',
    '2026-10-24T09:00:00.000Z',
    '2026-10-24T09:00:00.000Z'
  );

