-- ---------------------------------------------------------------------------
-- Release-drill dataset. NOT demo data, NOT pilot data.
--
-- Used by the local backup/restore drill described in docs/PILOT-RUNBOOK.md
-- (section "Local recovery drill"). It is applied to a **scratch copy** of this
-- repository, never to the developer database, the browser suite's database, or
-- a remote one, and it is applied with `wrangler d1 execute --file` rather than
-- through `db:seed:demo`, because that command is demo-only by design and this
-- drill must not relax a guard to run.
--
-- It exists to give a backup something worth restoring: identity and access, an
-- accepted quote revision and its order, a confirmed receipt with its event, an
-- escrow ledger entry, configuration versions with rollback lineage, and audit
-- rows that predate migration 0007 (so they must come back labelled 'app').
--
-- Deliberately **no founder_admin**: the point of the drill is that
-- `pnpm bootstrap:founder` supplies the first one, in this database, after 0007.
-- ---------------------------------------------------------------------------

INSERT INTO workspaces (id, name, created_at, updated_at) VALUES
  ('ws-drill-a', 'Vườn drill A', '2026-10-25T02:00:00.000Z', '2026-10-25T02:00:00.000Z'),
  ('ws-drill-b', 'Vườn drill B', '2026-10-25T02:00:00.000Z', '2026-10-25T02:00:00.000Z');

INSERT INTO identities (id, access_sub, email, display_name, created_at) VALUES
  ('id-drill-owner',    'sub-drill-owner',    'owner@drill.test',    'Chủ vườn drill',  '2026-10-25T02:00:00.000Z'),
  ('id-drill-operator', 'sub-drill-operator', 'operator@drill.test', 'Nhân viên drill', '2026-10-25T02:00:00.000Z');

INSERT INTO memberships (id, identity_id, workspace_id, role, granted_by, granted_at, revoked_at) VALUES
  ('mb-drill-owner-a',    'id-drill-owner',    'ws-drill-a', 'workspace_owner',    NULL, '2026-10-25T02:00:00.000Z', NULL),
  ('mb-drill-operator-a', 'id-drill-operator', 'ws-drill-a', 'workspace_operator', NULL, '2026-10-25T02:00:00.000Z', NULL);

INSERT INTO products (id, workspace_id, name, species, size_class, grade, price_vnd, unit, stock_note, is_active, created_at, updated_at) VALUES
  ('pr-drill-1', 'ws-drill-a', 'Hồng nhung', 'Hồng', '60cm', 'A', 5200, 'cành', NULL, 1,
   '2026-10-25T02:00:00.000Z', '2026-10-25T02:00:00.000Z');

INSERT INTO customers (id, workspace_id, name, contact_name, phone, address, note, created_at, updated_at) VALUES
  ('cu-drill-1', 'ws-drill-a', 'Shop Drill', 'Chị Tư', '0900000101', 'Chợ Sa Đéc', NULL,
   '2026-10-25T02:00:00.000Z', '2026-10-25T02:00:00.000Z');

INSERT INTO quote_chains (id, workspace_id, customer_id, reference, created_at, updated_at) VALUES
  ('qc-drill-1', 'ws-drill-a', 'cu-drill-1', 'BG-DRILL-1',
   '2026-10-25T02:00:00.000Z', '2026-10-25T02:10:00.000Z');

INSERT INTO quote_revisions (
  id, chain_id, workspace_id, revision_number, status, lines_json,
  subtotal_vnd, discount_vnd, fees_vnd, total_vnd, valid_until, conditions_note,
  issued_at, accepted_at, created_at, updated_at
) VALUES
  ('qr-drill-1', 'qc-drill-1', 'ws-drill-a', 1, 'accepted', '[]',
   2600000, 0, 0, 2600000, NULL, NULL,
   '2026-10-25T02:05:00.000Z', '2026-10-25T02:10:00.000Z',
   '2026-10-25T02:00:00.000Z', '2026-10-25T02:10:00.000Z');

INSERT INTO orders (
  id, workspace_id, quote_chain_id, accepted_revision_id, customer_id, order_code,
  total_vnd, deposit_required_vnd, pilot_credit_applied_vnd, collected_vnd,
  refund_owed_vnd, status, note, created_at, updated_at
) VALUES
  ('or-drill-1', 'ws-drill-a', 'qc-drill-1', 'qr-drill-1', 'cu-drill-1', 'ORD-DRILL-1',
   2600000, 780000, 0, 780000, 0, 'deposit_confirmed', NULL,
   '2026-10-25T02:10:00.000Z', '2026-10-25T02:20:00.000Z');

INSERT INTO receipts (
  id, workspace_id, order_id, amount_vnd, status, reference, confirmed_by,
  confirmed_at, reversal_reason, reversed_by, reversed_at, note, created_at, updated_at
) VALUES
  ('rc-drill-1', 'ws-drill-a', 'or-drill-1', 780000, 'confirmed', 'BG-DRILL-778',
   'id-drill-owner', '2026-10-25T02:20:00.000Z', NULL, NULL, NULL, 'cọc 30%',
   '2026-10-25T02:15:00.000Z', '2026-10-25T02:20:00.000Z');

INSERT INTO receipt_events (id, receipt_id, kind, actor_id, amount_vnd, detail, created_at) VALUES
  ('re-drill-1', 'rc-drill-1', 'confirm', 'id-drill-owner', 780000, 'xác nhận chuyển khoản',
   '2026-10-25T02:20:00.000Z');

-- A published B2B lot and a booking with a held deposit, so the ledger entry below
-- has the parent row its foreign key requires.
INSERT INTO supply_lots (
  id, lot_code, nursery_workspace_id, name, mode, species, grade, pot_diameter_cm,
  height_cm, canopy_cm, bud_specification, media_proof_url, unit, unit_price_vnd,
  deposit_rate_bps, moq_units, total_units, available_units, cut_or_ship_date,
  qr_lot_token, status, created_at, updated_at
) VALUES (
  'lot-drill-1', 'LOT-DRILL-1', 'ws-drill-a', 'Hồng nhung drill', 'WEEKLY_CATALOG', 'Hồng', 'A', 20,
  60, 40, 'nụ đều', 'https://example.test/proof.jpg', 'chậu', 260000,
  3000, 10, 600, 540, '2026-10-28', 'qr-lot-drill-1', 'PUBLISHED',
  '2026-10-25T02:00:00.000Z', '2026-10-25T02:00:00.000Z'
);

INSERT INTO b2b_bookings (
  id, booking_code, lot_id, nursery_workspace_id, buyer_workspace_id, buyer_shop_name,
  buyer_contact_phone, destination_market, quantity, unit_price_vnd, gross_total_vnd,
  deposit_rate_bps, deposit_required_vnd, deposit_paid_vnd, platform_fee_bps,
  platform_fee_vnd, status, note, created_at, updated_at
) VALUES (
  'bk-drill-1', 'SDEC-BK-DRILL', 'lot-drill-1', 'ws-drill-a', 'ws-drill-b', 'Shop Drill B',
  '0900000102', 'Chợ drill', 10, 260000, 2600000,
  3000, 780000, 780000, 300,
  78000, 'ESCROW_HELD', NULL, '2026-10-25T02:00:00.000Z', '2026-10-25T02:20:00.000Z'
);

INSERT INTO escrow_ledger_entries (id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at) VALUES
  ('el-drill-1', 'bk-drill-1', 'DEPOSIT_HELD', 780000, 'BG-DRILL-778', 'cọc giữ hộ',
   '2026-10-25T02:20:00.000Z');

INSERT INTO config_versions (
  id, scope, workspace_id, version_number, parameters_json, created_by, created_at, restored_from_version_id
) VALUES
  ('cv-drill-1', 'business_model', 'ws-drill-a', 1, '{"deposit_rate_bps":3000}',
   'id-drill-owner', '2026-10-25T02:00:00.000Z', NULL),
  ('cv-drill-2', 'business_model', 'ws-drill-a', 2, '{"deposit_rate_bps":2500}',
   'id-drill-owner', '2026-10-25T03:00:00.000Z', 'cv-drill-1');

INSERT INTO active_config_pointers (scope, workspace_id, active_version_id, updated_at) VALUES
  ('business_model', 'ws-drill-a', 'cv-drill-2', '2026-10-25T03:00:00.000Z');

-- Audit rows written before 0007 existed. They carry an actor identity and no
-- actor_source column, which is exactly the shape 0007 has to classify as 'app'.
INSERT INTO audit_events (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at) VALUES
  ('ae-drill-grant', 'ws-drill-a', 'id-drill-owner', 'membership.granted', 'membership', 'mb-drill-operator-a',
   'operator granted by owner', '2026-10-25T02:00:00.000Z'),
  ('ae-drill-receipt', 'ws-drill-a', 'id-drill-owner', 'receipt.confirmed', 'receipt', 'rc-drill-1',
   'BG-DRILL-778', '2026-10-25T02:20:00.000Z'),
  ('ae-drill-rollback', 'ws-drill-a', 'id-drill-owner', 'config.rollback', 'config_version', 'cv-drill-2',
   'restored cv-drill-1', '2026-10-25T03:00:00.000Z');
