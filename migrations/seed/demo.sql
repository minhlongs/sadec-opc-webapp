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
