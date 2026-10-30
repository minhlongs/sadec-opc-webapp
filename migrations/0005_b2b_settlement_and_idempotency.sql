-- 0005 — B2B settlement obligations separated from cash movements, and
--         idempotency keys for money-moving POSTs.
--
-- Why this migration exists
--
--   Inspection used to write BALANCE_COLLECTED, PLATFORM_FEE_RETAINED and
--   NURSERY_PAYOUT_RELEASED into `escrow_ledger_entries` the moment a buyer
--   recorded accepted/defective units. Nobody had received the balance; the
--   number was the amount the buyer *should* pay. A ledger that records money
--   it never saw is not a ledger. From this migration on:
--
--     * `b2b_settlements` holds what inspection *computes*: units, the amounts
--       receivable from the buyer, payable to the nursery and refundable, and
--       the deposit already confirmed. These are obligations, not cash.
--     * `escrow_ledger_entries` holds only movements a founder has confirmed
--       with a reference (DEPOSIT_HELD at deposit confirmation; the balance,
--       fee, refund and payout rows at settlement confirmation).
--
--   The ledger here is a *simulated* escrow: it records confirmations typed by
--   a person, not bank credits. No table in this schema is evidence that money
--   moved.
--
-- Idempotency
--
--   A booking, a deposit confirmation, a settlement confirmation or a receipt
--   sent twice because the network dropped the first answer must not become two
--   records. `idempotency_keys` stores the first response for a key, bound to
--   the workspace and the route, with a hash of the request so the same key
--   with a different body is refused rather than replayed.
--
-- Upgrade path: additive only. Existing bookings that inspection already moved
-- to INSPECTED_* keep their ledger rows; no row is rewritten, because the rows
-- were written under the old rule and history stays as it was. New settlements
-- start from this table.

CREATE TABLE b2b_settlements (
  id                          TEXT PRIMARY KEY,
  booking_id                  TEXT NOT NULL UNIQUE REFERENCES b2b_bookings(id),
  -- Denormalised from the booking so every tenant query carries its workspaces.
  buyer_workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  nursery_workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  accepted_units              INTEGER NOT NULL CHECK (accepted_units >= 0),
  defective_units             INTEGER NOT NULL CHECK (defective_units >= 0),
  -- CARRIER exists in the domain type but has no approved cost rule, so it is
  -- not accepted here until a product decision defines who bears it.
  fault_party                 TEXT NOT NULL CHECK (fault_party IN ('NONE', 'NURSERY')),
  -- Obligations the inspection computed. All integer VND, all >= 0.
  accepted_value_vnd          INTEGER NOT NULL CHECK (accepted_value_vnd >= 0),
  nursery_deduction_vnd       INTEGER NOT NULL CHECK (nursery_deduction_vnd >= 0),
  platform_fee_vnd            INTEGER NOT NULL CHECK (platform_fee_vnd >= 0),
  deposit_paid_vnd            INTEGER NOT NULL CHECK (deposit_paid_vnd >= 0),
  buyer_balance_required_vnd  INTEGER NOT NULL CHECK (buyer_balance_required_vnd >= 0),
  buyer_refund_vnd            INTEGER NOT NULL CHECK (buyer_refund_vnd >= 0),
  nursery_payout_vnd          INTEGER NOT NULL CHECK (nursery_payout_vnd >= 0),
  -- Cash the founder confirmed receiving for the balance. 0 until confirmed.
  balance_collected_vnd       INTEGER NOT NULL DEFAULT 0 CHECK (balance_collected_vnd >= 0),
  balance_collected_ref       TEXT,
  balance_collected_at        TEXT,
  -- AWAITING_BALANCE: buyer owes a balance nobody has confirmed.
  -- READY_TO_RELEASE: nothing owed by the buyer (balance 0 or refund case),
  --                   payout/refund still unconfirmed.
  -- RELEASED: founder confirmed; ledger rows written; booking SETTLED.
  status                      TEXT NOT NULL CHECK (status IN ('AWAITING_BALANCE', 'READY_TO_RELEASE', 'RELEASED')),
  inspected_by                TEXT NOT NULL REFERENCES identities(id),
  inspected_at                TEXT NOT NULL,
  released_by                 TEXT REFERENCES identities(id),
  released_at                 TEXT,
  note                        TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  CHECK (balance_collected_vnd <= buyer_balance_required_vnd),
  CHECK ((status = 'RELEASED') = (released_at IS NOT NULL))
);

CREATE INDEX b2b_settlements_by_buyer ON b2b_settlements(buyer_workspace_id, status);
CREATE INDEX b2b_settlements_by_nursery ON b2b_settlements(nursery_workspace_id, status);

-- Hub trips were seeded only; a route now creates them, and the trip records
-- who opened it. Nullable because seeded rows predate the column.
ALTER TABLE hub_dispatch_trips ADD COLUMN created_by TEXT REFERENCES identities(id);

CREATE TABLE idempotency_keys (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  action_path     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  -- SHA-256 of path + body, so a replay with a different body is refused.
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status INTEGER,
  response_body   TEXT,
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  PRIMARY KEY (workspace_id, action_path, idempotency_key)
);

CREATE INDEX idempotency_keys_by_created ON idempotency_keys(created_at);
