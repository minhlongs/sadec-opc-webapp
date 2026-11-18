-- ---------------------------------------------------------------------------
-- 0008: scope orders.order_code uniqueness to (workspace_id, order_code)
--
-- Why this migration exists
--
--   `0004_part_a_ops_and_founder.sql` declared `orders.order_code TEXT NOT NULL UNIQUE`
--   without `workspace_id`. `acceptRevision` mints `ORD-${chain.reference}-${revision.revision_number}`,
--   while `quote_chains.reference` is legitimately scoped by `UNIQUE (workspace_id, reference)`.
--   Two independent workspaces accepting `BG-2026-001` v1 therefore collided on the global
--   `orders.order_code` index and failed with a SQLite UNIQUE constraint error.
--
-- Upgrade path
--
--   Cloudflare D1 executes each migration inside a transaction where `PRAGMA foreign_keys = OFF`
--   is a no-op, so `orders` cannot be dropped while `receipts`, `receipt_events`, `deliveries`,
--   and `follow_up_tasks` hold foreign keys to it. We stage the four child tables in `*_new`
--   without foreign keys, drop the old child tables (and `receipt_events`), rebuild `orders`
--   with `UNIQUE (workspace_id, order_code)`, recreate the child tables with full foreign keys,
--   restore their rows, and drop the staging tables. Every statement runs inside D1's single
--   atomic migration transaction.
-- ---------------------------------------------------------------------------

-- 1. Stage child rows so `orders` has zero inbound foreign-key references.
CREATE TABLE receipt_events_stage AS SELECT * FROM receipt_events;
CREATE TABLE receipts_stage AS SELECT * FROM receipts;
CREATE TABLE deliveries_stage AS SELECT * FROM deliveries;
CREATE TABLE follow_up_tasks_stage AS SELECT * FROM follow_up_tasks;

DROP TABLE receipt_events;
DROP TABLE receipts;
DROP TABLE deliveries;
DROP TABLE follow_up_tasks;

-- 2. Rebuild `orders` with workspace-scoped `UNIQUE (workspace_id, order_code)`.
CREATE TABLE orders_new (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id),
  quote_chain_id           TEXT NOT NULL UNIQUE REFERENCES quote_chains(id),
  accepted_revision_id     TEXT NOT NULL UNIQUE REFERENCES quote_revisions(id),
  customer_id              TEXT NOT NULL REFERENCES customers(id),
  order_code               TEXT NOT NULL,
  total_vnd                INTEGER NOT NULL CHECK (total_vnd >= 0),
  deposit_required_vnd     INTEGER NOT NULL CHECK (deposit_required_vnd >= 0),
  pilot_credit_applied_vnd INTEGER NOT NULL DEFAULT 0 CHECK (pilot_credit_applied_vnd >= 0),
  collected_vnd            INTEGER NOT NULL DEFAULT 0 CHECK (collected_vnd >= 0),
  refund_owed_vnd          INTEGER NOT NULL DEFAULT 0 CHECK (refund_owed_vnd >= 0),
  status                   TEXT NOT NULL CHECK (status IN ('pending_deposit', 'deposit_confirmed', 'processing', 'scheduled', 'delivered', 'cancelled')),
  note                     TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (workspace_id, order_code),
  CHECK (collected_vnd <= total_vnd)
);

INSERT INTO orders_new (
  id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
  order_code, total_vnd, deposit_required_vnd, pilot_credit_applied_vnd,
  collected_vnd, refund_owed_vnd, status, note, created_at, updated_at
)
SELECT
  id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
  order_code, total_vnd, deposit_required_vnd, pilot_credit_applied_vnd,
  collected_vnd, refund_owed_vnd, status, note, created_at, updated_at
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

CREATE INDEX orders_by_workspace ON orders(workspace_id, created_at DESC);
CREATE INDEX orders_by_status ON orders(status, created_at DESC);

-- 3. Recreate child tables with identical schema, CHECKs, FKs, and indexes, then restore rows.
CREATE TABLE receipts (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  order_id        TEXT NOT NULL REFERENCES orders(id),
  amount_vnd      INTEGER NOT NULL CHECK (amount_vnd > 0),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'reversed')),
  reference       TEXT NOT NULL,
  confirmed_by    TEXT REFERENCES identities(id),
  confirmed_at    TEXT,
  reversal_reason TEXT,
  reversed_by     TEXT REFERENCES identities(id),
  reversed_at     TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

INSERT INTO receipts SELECT * FROM receipts_stage;
DROP TABLE receipts_stage;
CREATE INDEX receipts_by_order ON receipts(order_id, status);

CREATE TABLE receipt_events (
  id              TEXT PRIMARY KEY,
  receipt_id      TEXT NOT NULL REFERENCES receipts(id),
  kind            TEXT NOT NULL CHECK (kind IN ('create', 'confirm', 'reverse')),
  actor_id        TEXT NOT NULL REFERENCES identities(id),
  amount_vnd      INTEGER NOT NULL CHECK (amount_vnd > 0),
  detail          TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (receipt_id, kind)
);

INSERT INTO receipt_events SELECT * FROM receipt_events_stage;
DROP TABLE receipt_events_stage;
CREATE INDEX receipt_events_by_receipt ON receipt_events(receipt_id, created_at ASC);

CREATE TABLE deliveries (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id),
  order_id               TEXT NOT NULL UNIQUE REFERENCES orders(id),
  scheduled_date         TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('scheduled', 'in_transit', 'delivered', 'failed', 'cancelled')),
  delivery_address       TEXT NOT NULL,
  under_deposit_override INTEGER NOT NULL DEFAULT 0 CHECK (under_deposit_override IN (0, 1)),
  override_reason        TEXT,
  override_by            TEXT REFERENCES identities(id),
  assigned_to            TEXT,
  note                   TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

INSERT INTO deliveries SELECT * FROM deliveries_stage;
DROP TABLE deliveries_stage;
CREATE INDEX deliveries_by_workspace ON deliveries(workspace_id, scheduled_date);

CREATE TABLE follow_up_tasks (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  order_id      TEXT REFERENCES orders(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  due_date      TEXT NOT NULL,
  task_kind     TEXT NOT NULL CHECK (task_kind IN ('deposit_reminder', 'delivery_confirm', 'quality_check', 'repeat_order')),
  status        TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
  assigned_to   TEXT REFERENCES identities(id),
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

INSERT INTO follow_up_tasks SELECT * FROM follow_up_tasks_stage;
DROP TABLE follow_up_tasks_stage;
CREATE INDEX follow_up_tasks_by_due ON follow_up_tasks(workspace_id, status, due_date);
