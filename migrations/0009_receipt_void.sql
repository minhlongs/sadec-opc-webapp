-- =============================================================================
-- Migration 0009: Pending Receipt Voiding & Issued Quote Customer Snapshot
-- =============================================================================
--
-- Two additive V1 pilot completion schema capabilities:
--   1. Allow unconfirmed ('pending') nursery receipts to transition to a
--      terminal 'voided' state with mandatory audit fields (`void_reason`,
--      `voided_by`, `voided_at`) and a matching `receipt_events.kind = 'void'`
--      row. Confirmed receipts still require `reverse` rather than `void`.
--   2. Add `quote_revisions.customer_snapshot_json` so issuing a quote freezes
--      the customer's name/contact/phone/address snapshot, preserving historical
--      A4 printouts and JSON exports when the customer record is edited later.
--
-- Cloudflare D1 runs each migration inside an implicit transaction where
-- `PRAGMA foreign_keys = OFF` is a no-op. `receipt_events` is the sole table
-- holding a foreign key to `receipts`, so we stage `receipt_events` and
-- `receipts`, drop child then parent, recreate `receipts` and `receipt_events`
-- with full foreign keys and updated CHECK constraints, restore all existing
-- rows without loss, and drop the staging tables.
-- =============================================================================

CREATE TABLE receipt_events_stage AS SELECT * FROM receipt_events;
CREATE TABLE receipts_stage AS SELECT * FROM receipts;

DROP TABLE receipt_events;
DROP TABLE receipts;

CREATE TABLE receipts (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  order_id        TEXT NOT NULL REFERENCES orders(id),
  amount_vnd      INTEGER NOT NULL CHECK (amount_vnd > 0),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'reversed', 'voided')),
  reference       TEXT NOT NULL,
  confirmed_by    TEXT REFERENCES identities(id),
  confirmed_at    TEXT,
  reversal_reason TEXT,
  reversed_by     TEXT REFERENCES identities(id),
  reversed_at     TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  void_reason     TEXT,
  voided_by       TEXT REFERENCES identities(id),
  voided_at       TEXT
);

INSERT INTO receipts (
  id, workspace_id, order_id, amount_vnd, status, reference,
  confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
  note, created_at, updated_at, void_reason, voided_by, voided_at
)
SELECT
  id, workspace_id, order_id, amount_vnd, status, reference,
  confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
  note, created_at, updated_at, NULL, NULL, NULL
FROM receipts_stage;

DROP TABLE receipts_stage;

CREATE INDEX receipts_by_order ON receipts(order_id, status);
CREATE INDEX receipts_by_workspace_status ON receipts(workspace_id, status, created_at DESC);

CREATE TABLE receipt_events (
  id              TEXT PRIMARY KEY,
  receipt_id      TEXT NOT NULL REFERENCES receipts(id),
  kind            TEXT NOT NULL CHECK (kind IN ('create', 'confirm', 'reverse', 'void')),
  actor_id        TEXT NOT NULL REFERENCES identities(id),
  amount_vnd      INTEGER NOT NULL CHECK (amount_vnd > 0),
  detail          TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (receipt_id, kind)
);

INSERT INTO receipt_events (
  id, receipt_id, kind, actor_id, amount_vnd, detail, created_at
)
SELECT
  id, receipt_id, kind, actor_id, amount_vnd, detail, created_at
FROM receipt_events_stage;

DROP TABLE receipt_events_stage;

CREATE INDEX receipt_events_by_receipt ON receipt_events(receipt_id, created_at ASC);

ALTER TABLE quote_revisions ADD COLUMN customer_snapshot_json TEXT;
