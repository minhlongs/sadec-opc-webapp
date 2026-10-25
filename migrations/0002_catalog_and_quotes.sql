-- Catalog, customers, quote drafts.
--
-- Written for the vertical slice: products, customers and a quote draft that
-- survives a restart. The tables phase 2 needs — quote revision, order, deposit,
-- delivery, follow-up — are deliberately absent, because a slice that renders
-- them as placeholder forms looks like a product and is not one.
--
-- The seed script inserts into these three tables, so this migration and the
-- seed must be applied together; the demo data is not usable without them.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------

-- A sellable item: a species, a size class, a grade.
--
-- price_vnd is INTEGER, not NUMERIC and not REAL. §7.2 requires VND money to be
-- an integer, and this column type refuses a fraction at the point of storage
-- rather than trusting every caller to validate — the same reason the first
-- migration typed its money columns this way.
--
-- is_active is a soft delete. A product that has appeared on a quote cannot be
-- removed without breaking the record of what was quoted, so it is made
-- inactive instead, and an inactive product is hidden from new quotes while
-- remaining readable on old ones.
CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  species       TEXT,
  size_class    TEXT,
  grade         TEXT,
  price_vnd     INTEGER NOT NULL CHECK (price_vnd >= 0),
  unit          TEXT NOT NULL,
  stock_note    TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (length(name) > 0)
);

CREATE INDEX products_by_workspace ON products(workspace_id, is_active, name);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

-- A buyer. Note what is not here: no identity, no login, no account. A customer
-- is a record the operator keeps; whether they may sign in is a separate
-- question §6 answers for staff only.
CREATE TABLE customers (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  address       TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (length(name) > 0)
);

CREATE INDEX customers_by_workspace ON customers(workspace_id, name);

-- ---------------------------------------------------------------------------
-- Quote drafts
-- ---------------------------------------------------------------------------

-- A quote being composed. `status` is 'draft' only at this phase; phase 2 adds
-- 'published' and the immutable revision rows that follow it.
--
-- The line items are stored as JSON rather than as a child table. This is a
-- deliberate choice for a draft that is composed and discarded in one sitting:
-- a draft is replaced wholesale when the operator edits it, so there is no
-- update-in-place race to guard, and a separate quote_lines table would need its
-- own delete-and-reinsert transaction for a shape that is only ever read whole.
--
-- The consequence is written down so a later reader does not have to rediscover
-- it: once a quote is published and its lines must stay immutable, the storage
-- moves to rows. Phase 2 does that move in a migration, not by editing this
-- table's meaning.
CREATE TABLE quote_drafts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  reference     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft')),
  lines_json    TEXT NOT NULL,
  -- Denormalised from lines_json, and computed by the server on every save.
  -- A client-supplied total is never trusted, so the column holds what the
  -- domain computed — which also means a stale UI cannot disagree with the value
  -- that will be charged.
  subtotal_vnd  INTEGER NOT NULL CHECK (subtotal_vnd >= 0),
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (length(reference) > 0)
);

CREATE INDEX quote_drafts_by_workspace ON quote_drafts(workspace_id, updated_at DESC);

-- One live draft per customer per workspace. Two operators on the same customer
-- compose into the same draft rather than each creating a parallel one that the
-- other cannot see — which is how a quote gets sent twice with different numbers.
CREATE UNIQUE INDEX quote_drafts_one_per_customer
  ON quote_drafts(workspace_id, customer_id)
  WHERE status = 'draft';
