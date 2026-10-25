-- B2B Floriculture Pre-order, Consolidation & Escrow Platform (Sa Đéc → TP.HCM)
--
-- Extends the foundation schema with multi-nursery verified supply profiles,
-- two-speed supply lots (weekly replenishment + Tết seasonal pre-orders),
-- escrow-backed B2B bookings, an append-only immutable escrow ledger,
-- and Sa Đéc → TP.HCM cross-docking hub trips with QR-signed shipment packages.
--
-- Invariants enforced at storage level:
--   1. Every monetary column is INTEGER VND >= 0, and every rate is basis points.
--   2. available_units >= 0 prevents overselling under concurrent bookings.
--   3. UNIQUE(booking_id, entry_type) prevents duplicate deposit or settlement
--      ledger postings on retry.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Verified Sa Đéc Nursery Profiles
-- ---------------------------------------------------------------------------

CREATE TABLE nursery_profiles (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  nursery_name          TEXT NOT NULL CHECK (length(nursery_name) > 0),
  hamlet_area           TEXT NOT NULL CHECK (hamlet_area IN ('Tân Quy Đông', 'Tân Khánh Đông', 'Sa Nhiên', 'Tân Quy Tây', 'Khác')),
  owner_name            TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  specialties_json      TEXT NOT NULL DEFAULT '[]',
  verified_status       TEXT NOT NULL DEFAULT 'VERIFIED' CHECK (verified_status IN ('PENDING', 'VERIFIED', 'SUSPENDED')),
  fulfillment_score_bps INTEGER NOT NULL DEFAULT 9800 CHECK (fulfillment_score_bps BETWEEN 0 AND 10000),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX nursery_profiles_by_workspace ON nursery_profiles(workspace_id);
CREATE INDEX nursery_profiles_by_hamlet ON nursery_profiles(hamlet_area, verified_status);

-- ---------------------------------------------------------------------------
-- 2. Two-Speed B2B Supply Lots (Weekly Replenishment + Seasonal Tết Pre-order)
-- ---------------------------------------------------------------------------

CREATE TABLE supply_lots (
  id                    TEXT PRIMARY KEY,
  lot_code              TEXT NOT NULL UNIQUE CHECK (length(lot_code) > 0),
  nursery_workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name                  TEXT NOT NULL CHECK (length(name) > 0),
  mode                  TEXT NOT NULL CHECK (mode IN ('WEEKLY_CATALOG', 'SEASONAL_PREORDER')),
  species               TEXT NOT NULL,
  grade                 TEXT NOT NULL DEFAULT 'A',
  pot_diameter_cm       INTEGER NOT NULL CHECK (pot_diameter_cm > 0),
  height_cm             INTEGER NOT NULL CHECK (height_cm > 0),
  canopy_cm             INTEGER NOT NULL CHECK (canopy_cm > 0),
  bud_specification     TEXT NOT NULL,
  media_proof_url       TEXT NOT NULL,
  unit                  TEXT NOT NULL DEFAULT 'chậu',
  unit_price_vnd        INTEGER NOT NULL CHECK (unit_price_vnd > 0),
  deposit_rate_bps      INTEGER NOT NULL CHECK (deposit_rate_bps BETWEEN 3000 AND 5000),
  moq_units             INTEGER NOT NULL CHECK (moq_units > 0),
  total_units           INTEGER NOT NULL CHECK (total_units > 0),
  available_units       INTEGER NOT NULL CHECK (available_units >= 0 AND available_units <= total_units),
  cut_or_ship_date      TEXT NOT NULL,
  qr_lot_token          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT', 'PUBLISHED', 'SOLD_OUT', 'ARCHIVED')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX supply_lots_by_mode_status ON supply_lots(mode, status, cut_or_ship_date);
CREATE INDEX supply_lots_by_nursery ON supply_lots(nursery_workspace_id, status);

-- ---------------------------------------------------------------------------
-- 3. B2B Pre-order Bookings (TP.HCM Shops → Sa Đéc Nurseries)
-- ---------------------------------------------------------------------------

CREATE TABLE b2b_bookings (
  id                    TEXT PRIMARY KEY,
  booking_code          TEXT NOT NULL UNIQUE CHECK (length(booking_code) > 0),
  lot_id                TEXT NOT NULL REFERENCES supply_lots(id),
  nursery_workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  buyer_workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  buyer_shop_name       TEXT NOT NULL,
  buyer_contact_phone   TEXT NOT NULL,
  destination_market    TEXT NOT NULL,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_vnd        INTEGER NOT NULL CHECK (unit_price_vnd > 0),
  gross_total_vnd       INTEGER NOT NULL CHECK (gross_total_vnd > 0),
  deposit_rate_bps      INTEGER NOT NULL CHECK (deposit_rate_bps BETWEEN 3000 AND 5000),
  deposit_required_vnd  INTEGER NOT NULL CHECK (deposit_required_vnd >= 0),
  deposit_paid_vnd      INTEGER NOT NULL DEFAULT 0 CHECK (deposit_paid_vnd >= 0),
  platform_fee_bps      INTEGER NOT NULL CHECK (platform_fee_bps BETWEEN 200 AND 500),
  platform_fee_vnd      INTEGER NOT NULL CHECK (platform_fee_vnd >= 0),
  status                TEXT NOT NULL DEFAULT 'BOOKED_PENDING_DEPOSIT' CHECK (
    status IN (
      'BOOKED_PENDING_DEPOSIT',
      'ESCROW_HELD',
      'HUB_CONSOLIDATED',
      'IN_TRANSIT',
      'INSPECTED_ACCEPTED',
      'INSPECTED_PARTIAL_DEFECT',
      'REJECTED_NURSERY_FAULT',
      'SETTLED',
      'CANCELLED'
    )
  ),
  note                  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX b2b_bookings_by_buyer ON b2b_bookings(buyer_workspace_id, created_at DESC);
CREATE INDEX b2b_bookings_by_nursery ON b2b_bookings(nursery_workspace_id, created_at DESC);
CREATE INDEX b2b_bookings_by_status ON b2b_bookings(status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Immutable Escrow Ledger Entries (Zero Working Capital Outlay)
-- ---------------------------------------------------------------------------

CREATE TABLE escrow_ledger_entries (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL REFERENCES b2b_bookings(id),
  entry_type    TEXT NOT NULL CHECK (
    entry_type IN (
      'DEPOSIT_HELD',
      'BALANCE_COLLECTED',
      'DEFECT_DEDUCTION',
      'BUYER_REFUND',
      'PLATFORM_FEE_RETAINED',
      'NURSERY_PAYOUT_RELEASED'
    )
  ),
  amount_vnd    INTEGER NOT NULL CHECK (amount_vnd >= 0),
  vietqr_ref    TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (booking_id, entry_type)
);

CREATE INDEX escrow_ledger_by_booking ON escrow_ledger_entries(booking_id, created_at ASC);

-- ---------------------------------------------------------------------------
-- 5. Sa Đéc → TP.HCM Cross-Docking Hub Dispatch Trips
-- ---------------------------------------------------------------------------

CREATE TABLE hub_dispatch_trips (
  id                    TEXT PRIMARY KEY,
  trip_code             TEXT NOT NULL UNIQUE CHECK (length(trip_code) > 0),
  truck_plate           TEXT NOT NULL,
  driver_name           TEXT NOT NULL,
  driver_phone          TEXT NOT NULL,
  departure_sa_dec_at   TEXT NOT NULL,
  eta_hcm_at            TEXT NOT NULL,
  destination_market    TEXT NOT NULL,
  capacity_units        INTEGER NOT NULL CHECK (capacity_units > 0),
  loaded_units          INTEGER NOT NULL DEFAULT 0 CHECK (loaded_units >= 0 AND loaded_units <= capacity_units),
  status                TEXT NOT NULL DEFAULT 'GATHERING' CHECK (status IN ('GATHERING', 'DEPARTED', 'ARRIVED', 'COMPLETED')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX hub_trips_by_status ON hub_dispatch_trips(status, departure_sa_dec_at);

-- ---------------------------------------------------------------------------
-- 6. QR-Signed Shipment Packages (2-Stage Verification Checkpoints)
-- ---------------------------------------------------------------------------

CREATE TABLE shipment_packages (
  id                        TEXT PRIMARY KEY,
  trip_id                   TEXT NOT NULL REFERENCES hub_dispatch_trips(id),
  booking_id                TEXT NOT NULL UNIQUE REFERENCES b2b_bookings(id),
  package_qr_token          TEXT NOT NULL,
  package_label             TEXT NOT NULL,
  units_count               INTEGER NOT NULL CHECK (units_count > 0),
  hub_inspection_status     TEXT NOT NULL DEFAULT 'PENDING' CHECK (hub_inspection_status IN ('PENDING', 'VERIFIED_OK', 'REJECTED')),
  hub_verified_at           TEXT,
  hub_note                  TEXT,
  buyer_inspection_status   TEXT NOT NULL DEFAULT 'PENDING' CHECK (buyer_inspection_status IN ('PENDING', 'ACCEPTED', 'PARTIAL_DEFECT', 'REJECTED')),
  buyer_inspected_at        TEXT,
  accepted_units            INTEGER NOT NULL DEFAULT 0 CHECK (accepted_units >= 0),
  defective_units           INTEGER NOT NULL DEFAULT 0 CHECK (defective_units >= 0),
  fault_party               TEXT NOT NULL DEFAULT 'NONE' CHECK (fault_party IN ('NONE', 'NURSERY', 'CARRIER')),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

CREATE INDEX shipment_packages_by_trip ON shipment_packages(trip_id);
CREATE INDEX shipment_packages_by_booking ON shipment_packages(booking_id);
