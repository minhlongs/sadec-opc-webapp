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

-- ---------------------------------------------------------------------------
-- Phase 2: Quote Chains, Quote Revisions, Orders, Receipts, Deliveries & Tasks
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO quote_chains (id, workspace_id, customer_id, reference, created_at, updated_at) VALUES
  ('qc-demo-01', 'ws-demo-a', 'cu-a-01', 'BG-2026-001', '2026-10-24T02:00:00.000Z', '2026-10-24T04:00:00.000Z'),
  ('qc-demo-02', 'ws-demo-a', 'cu-a-02', 'BG-2026-002', '2026-10-24T03:00:00.000Z', '2026-10-24T05:00:00.000Z'),
  ('qc-demo-03', 'ws-demo-a', 'cu-a-04', 'BG-2026-003', '2026-10-24T06:00:00.000Z', '2026-10-24T06:00:00.000Z');

INSERT OR IGNORE INTO quote_revisions (
  id, chain_id, workspace_id, revision_number, status, lines_json,
  subtotal_vnd, discount_vnd, fees_vnd, total_vnd,
  valid_until, conditions_note, issued_at, accepted_at, created_at, updated_at
) VALUES
  (
    'qr-demo-01-r1',
    'qc-demo-01',
    'ws-demo-a',
    1,
    'superseded',
    '[{"product_id":"pd-a-02","product_name":"Cau vàng","unit":"chậu","unit_price_vnd":350000,"quantity":20,"line_total_vnd":7000000,"note":"Chọn bụi đều"}]',
    7000000,
    0,
    300000,
    7300000,
    '2026-11-05',
    'Cọc 30% khi chốt đơn, giao tại vườn Sa Đéc.',
    '2026-10-24T02:30:00.000Z',
    NULL,
    '2026-10-24T02:00:00.000Z',
    '2026-10-24T03:00:00.000Z'
  ),
  (
    'qr-demo-01-r2',
    'qc-demo-01',
    'ws-demo-a',
    2,
    'accepted',
    '[{"product_id":"pd-a-02","product_name":"Cau vàng","unit":"chậu","unit_price_vnd":350000,"quantity":30,"line_total_vnd":10500000,"note":"Tăng lên 30 chậu"},{"product_id":"pd-a-05","product_name":"Lan Ý","unit":"chậu","unit_price_vnd":450000,"quantity":10,"line_total_vnd":4500000,"note":null}]',
    15000000,
    500000,
    500000,
    15000000,
    '2026-11-10',
    'Cọc 30% trước khi bốc cây, hỗ trợ đóng bầu lưới.',
    '2026-10-24T03:30:00.000Z',
    '2026-10-24T04:00:00.000Z',
    '2026-10-24T03:00:00.000Z',
    '2026-10-24T04:00:00.000Z'
  ),
  (
    'qr-demo-02-r1',
    'qc-demo-02',
    'ws-demo-a',
    1,
    'issued',
    '[{"product_id":"pd-a-12","product_name":"Lộc vừng","unit":"cây","unit_price_vnd":890000,"quantity":10,"line_total_vnd":8900000,"note":"Cây công trình giai đoạn 2"}]',
    8900000,
    0,
    600000,
    9500000,
    '2026-11-15',
    'Báo giá có hiệu lực 15 ngày.',
    '2026-10-24T05:00:00.000Z',
    NULL,
    '2026-10-24T03:00:00.000Z',
    '2026-10-24T05:00:00.000Z'
  ),
  (
    'qr-demo-03-r1',
    'qc-demo-03',
    'ws-demo-a',
    1,
    'draft',
    '[{"product_id":"pd-a-08","product_name":"Sanh Nam Bộ","unit":"chậu","unit_price_vnd":95000,"quantity":100,"line_total_vnd":9500000,"note":"Bản nháp đang chờ khách chốt số lượng"}]',
    9500000,
    0,
    0,
    9500000,
    '2026-11-20',
    'Nháp nội bộ.',
    NULL,
    NULL,
    '2026-10-24T06:00:00.000Z',
    '2026-10-24T06:00:00.000Z'
  );

INSERT OR IGNORE INTO orders (
  id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
  order_code, total_vnd, deposit_required_vnd, pilot_credit_applied_vnd,
  collected_vnd, refund_owed_vnd, status, note, created_at, updated_at
) VALUES
  (
    'ord-demo-01',
    'ws-demo-a',
    'qc-demo-01',
    'qr-demo-01-r2',
    'cu-a-01',
    'ORD-DEMO001',
    15000000,
    4500000,
    0,
    4500000,
    0,
    'scheduled',
    'Khách đã cọc đủ 30%, hẹn giao sáng sớm.',
    '2026-10-24T04:00:00.000Z',
    '2026-10-24T05:00:00.000Z'
  );

INSERT OR IGNORE INTO receipts (
  id, workspace_id, order_id, amount_vnd, status, reference,
  confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
  note, created_at, updated_at
) VALUES
  (
    'rc-demo-01',
    'ws-demo-a',
    'ord-demo-01',
    4500000,
    'confirmed',
    'VCB-99881122-COC30',
    'id-demo-owner',
    '2026-10-24T04:30:00.000Z',
    NULL,
    NULL,
    NULL,
    'Thu cọc 30% đơn ORD-DEMO001',
    '2026-10-24T04:15:00.000Z',
    '2026-10-24T04:30:00.000Z'
  );

INSERT OR IGNORE INTO receipt_events (
  id, receipt_id, kind, actor_id, amount_vnd, detail, created_at
) VALUES
  ('re-demo-01-c', 'rc-demo-01', 'create',  'id-demo-operator', 4500000, 'Tạo phiếu thu cọc', '2026-10-24T04:15:00.000Z'),
  ('re-demo-01-f', 'rc-demo-01', 'confirm', 'id-demo-owner',    4500000, 'Chủ vườn xác nhận tiền về tài khoản', '2026-10-24T04:30:00.000Z');

INSERT OR IGNORE INTO deliveries (
  id, workspace_id, order_id, scheduled_date, status, delivery_address,
  under_deposit_override, override_reason, override_by, assigned_to, note,
  created_at, updated_at
) VALUES
  (
    'dlv-demo-01',
    'ws-demo-a',
    'ord-demo-01',
    '2026-10-26',
    'scheduled',
    'Đường Nguyễn Sinh Sắc, Sa Đéc',
    0,
    NULL,
    NULL,
    'Tài xế Minh (Xe tải 2.5T)',
    'Bốc cây lúc 05:30 sáng.',
    '2026-10-24T05:00:00.000Z',
    '2026-10-24T05:00:00.000Z'
  );

INSERT OR IGNORE INTO follow_up_tasks (
  id, workspace_id, order_id, customer_id, due_date, task_kind,
  status, assigned_to, note, created_at, updated_at
) VALUES
  (
    'tsk-demo-01',
    'ws-demo-a',
    'ord-demo-01',
    'cu-a-01',
    '2026-10-26',
    'delivery_confirm',
    'open',
    'id-demo-operator',
    'Gọi chị Hương xác nhận giờ nhận cây sáng nay.',
    '2026-10-24T05:00:00.000Z',
    '2026-10-24T05:00:00.000Z'
  ),
  (
    'tsk-demo-02',
    'ws-demo-a',
    NULL,
    'cu-a-02',
    '2026-10-26',
    'deposit_reminder',
    'open',
    'id-demo-operator',
    'Nhắc anh Tới phản hồi báo giá BG-2026-002.',
    '2026-10-24T05:30:00.000Z',
    '2026-10-24T05:30:00.000Z'
  );

-- ---------------------------------------------------------------------------
-- Phase 3: Founder Interviews, Observations, Config Versions & OPC Ledger
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO founder_interviews (
  id, external_id, organization_alias, respondent_role, interviewed_at,
  data_origin, notes, recorded_by, revision, created_at, updated_at
) VALUES
  (
    'int-demo-01',
    'INT-SADEC-001',
    'DEMO — Nhà vườn Tân Quy Đông #1',
    'Chủ vườn hoa kiểng 2.5 ha',
    '2026-10-20',
    'synthetic',
    'Khảo sát nhu cầu quản lý báo giá sỉ và đặt cọc vụ Tết.',
    'id-demo-admin',
    1,
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  ),
  (
    'int-demo-02',
    'INT-SADEC-002',
    'DEMO — Hợp tác xã Kiểng Lá Sa Nhiên',
    'Điều phối viên xuất hàng',
    '2026-10-21',
    'synthetic',
    'Mất nhiều giờ đối chiếu cọc chuyển khoản và lịch xe tải.',
    'id-demo-admin',
    1,
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  ),
  (
    'int-demo-03',
    'INT-SADEC-003',
    'DEMO — Vườn Mai Tân Khánh Đông',
    'Chủ vườn',
    '2026-10-22',
    'synthetic',
    'Sẵn sàng trả phí thí điểm nếu giảm được sai sót báo giá nhiều lần.',
    'id-demo-admin',
    1,
    '2026-10-23T02:00:00.000Z',
    '2026-10-23T02:00:00.000Z'
  );

INSERT OR IGNORE INTO founder_observations (
  id, interview_id, metric_key, value_num, value_str, unit, period,
  evidence_kind, source_ref, is_null, revision, created_at
) VALUES
  ('obs-demo-01', 'int-demo-01', 'willingness_to_pay_vnd',           3000000, NULL, 'VND',   'month', 'reported',   'Ghi âm phỏng vấn #1 phút 14', 0, 1, '2026-10-23T02:00:00.000Z'),
  ('obs-demo-02', 'int-demo-01', 'support_hours_per_customer_month', 4,       NULL, 'hours', 'month', 'assumption', 'Ước tính hỗ trợ tại vườn',    0, 1, '2026-10-23T02:00:00.000Z'),
  ('obs-demo-03', 'int-demo-02', 'setup_hours_per_customer',         24,      NULL, 'hours', 'once',  'measured',   'Đo từ đợt nhập danh mục thử', 0, 1, '2026-10-23T02:00:00.000Z'),
  ('obs-demo-04', 'int-demo-03', 'pilot_fee_vnd',                    3000000, NULL, 'VND',   'once',  'reported',   'Chủ vườn đồng ý gói pilot',   0, 1, '2026-10-23T02:00:00.000Z');

INSERT OR IGNORE INTO config_versions (
  id, scope, workspace_id, version_number, parameters_json, proposal_id,
  created_by, created_at
) VALUES
  (
    'cv-demo-bm-v1',
    'business_model',
    NULL,
    1,
    '{"pilot_fee_vnd":3000000,"setup_fee_vnd":10000000,"monthly_fee_vnd":3000000,"direct_cost_per_customer_month_vnd":350000,"direct_cost_per_setup_vnd":500000,"fixed_cost_per_month_vnd":2500000,"founder_hourly_value_vnd":150000,"support_hours_per_customer_month":4,"setup_hours_per_customer":24,"sales_hours_per_month":24,"maintenance_hours_per_month":16,"admin_hours_per_month":16,"buffer_hours_per_month":16,"capacity_hours_per_month":160,"minimum_benefit_cost_ratio":3}',
    NULL,
    'id-demo-admin',
    '2026-10-23T02:00:00.000Z'
  );

INSERT OR IGNORE INTO active_config_pointers (
  scope, workspace_id, active_version_id, updated_at
) VALUES
  ('business_model', 'global', 'cv-demo-bm-v1', '2026-10-23T02:00:00.000Z');

INSERT OR IGNORE INTO change_proposals (
  id, scope, workspace_id, base_version_id, changes_json, evidence_ids_json,
  rationale, status, proposed_by, approved_by, approved_at, created_at, updated_at
) VALUES
  (
    'cp-demo-01',
    'business_model',
    NULL,
    'cv-demo-bm-v1',
    '{"support_hours_per_customer_month":3}',
    '["obs-demo-02","obs-demo-03"]',
    'Giảm giờ hỗ trợ hàng tháng từ 4h xuống 3h nhờ mẫu báo giá chuẩn hóa.',
    'draft',
    'id-demo-admin',
    NULL,
    NULL,
    '2026-10-24T02:00:00.000Z',
    '2026-10-24T02:00:00.000Z'
  );

INSERT OR IGNORE INTO opc_agreements (
  id, workspace_id, status, monthly_fee_vnd, setup_fee_vnd,
  effective_date, termination_date, price_plane_snapshot_json, created_at, updated_at
) VALUES
  (
    'ag-demo-a',
    'ws-demo-a',
    'active',
    3000000,
    10000000,
    '2026-10-01',
    NULL,
    '{"pilot_fee_vnd":3000000,"setup_fee_vnd":10000000,"monthly_fee_vnd":3000000}',
    '2026-10-01T00:00:00.000Z',
    '2026-10-24T02:00:00.000Z'
  );

INSERT OR IGNORE INTO opc_obligations (
  id, agreement_id, workspace_id, obligation_kind, amount_vnd,
  due_date, status, created_at, updated_at
) VALUES
  ('ob-demo-pilot', 'ag-demo-a', 'ws-demo-a', 'pilot_fee',            3000000,  '2026-10-05', 'settled', '2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
  ('ob-demo-setup', 'ag-demo-a', 'ws-demo-a', 'setup_fee',            10000000, '2026-10-25', 'settled', '2026-10-15T00:00:00.000Z', '2026-10-24T00:00:00.000Z'),
  ('ob-demo-m11',   'ag-demo-a', 'ws-demo-a', 'monthly_subscription', 3000000,  '2026-11-05', 'pending', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z');

INSERT OR IGNORE INTO opc_receipts (
  id, agreement_id, workspace_id, obligation_id, amount_vnd, fee_type,
  reference, status, confirmed_by, confirmed_at, note, created_at, updated_at
) VALUES
  (
    'opcrc-demo-pilot',
    'ag-demo-a',
    'ws-demo-a',
    'ob-demo-pilot',
    3000000,
    'pilot_fee',
    'OPC-PILOT-WSA-01',
    'confirmed',
    'id-demo-admin',
    '2026-10-05T02:00:00.000Z',
    'Thu phí thí điểm 3.000.000đ (được khấu trừ khi nâng cấp)',
    '2026-10-05T02:00:00.000Z',
    '2026-10-05T02:00:00.000Z'
  ),
  (
    'opcrc-demo-setup',
    'ag-demo-a',
    'ws-demo-a',
    'ob-demo-setup',
    7000000,
    'upgrade_fee',
    'OPC-UPGRADE-WSA-01',
    'confirmed',
    'id-demo-admin',
    '2026-10-24T02:00:00.000Z',
    'Thu phần chênh lệch nâng cấp 7.000.000đ sau khi cấn trừ 3.000.000đ pilot credit',
    '2026-10-24T02:00:00.000Z',
    '2026-10-24T02:00:00.000Z'
  );

INSERT OR IGNORE INTO pilot_credits (
  id, workspace_id, pilot_receipt_id, credit_amount_vnd,
  applied_to_obligation_id, applied_at, created_at
) VALUES
  (
    'pc-demo-a',
    'ws-demo-a',
    'opcrc-demo-pilot',
    3000000,
    'ob-demo-setup',
    '2026-10-24T02:00:00.000Z',
    '2026-10-05T02:00:00.000Z'
  );


