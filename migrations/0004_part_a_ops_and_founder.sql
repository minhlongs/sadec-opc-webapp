-- Sa Đéc Flow — Part A: Nursery Operations Transactions & Founder Discovery Engine
--
-- Implements Phase 2 (Nursery Ops Transactions) and Phase 3 (Founder Discovery Engine).
-- Invariants enforced at schema level:
--   1. Quote Revisions: draft -> issued -> accepted / declined / expired / superseded.
--      In one chain, exactly one accepted revision (partial unique index).
--   2. Orders: UNIQUE(quote_chain_id) ensures 1 order per quote revision chain.
--      Over-payment is bounded: collected <= order total.
--   3. Receipts: UNIQUE(receipt_id, kind) on receipt events to prevent double counting.
--   4. Deliveries & Follow-ups: status tracking, owner override recorded for under-deposit delivery.
--   5. Founder Area: Interviews & observations with revision & evidence kinds.
--      Change proposals & immutable config versions with optimistic concurrency (base_version_id).
--      Active config pointers keyed by (scope, workspace_id).
--      OPC agreement/obligation/pilot credit/receipt ledger.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Phase 2: Quotes, Revisions & Line Snapshots
-- ---------------------------------------------------------------------------

CREATE TABLE quote_chains (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  reference     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX quote_chains_by_workspace ON quote_chains(workspace_id, updated_at DESC);

CREATE TABLE quote_revisions (
  id              TEXT PRIMARY KEY,
  chain_id        TEXT NOT NULL REFERENCES quote_chains(id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  status          TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'accepted', 'declined', 'expired', 'superseded')),
  lines_json      TEXT NOT NULL,
  subtotal_vnd    INTEGER NOT NULL CHECK (subtotal_vnd >= 0),
  discount_vnd    INTEGER NOT NULL DEFAULT 0 CHECK (discount_vnd >= 0),
  fees_vnd        INTEGER NOT NULL DEFAULT 0 CHECK (fees_vnd >= 0),
  total_vnd       INTEGER NOT NULL CHECK (total_vnd >= 0),
  valid_until     TEXT,
  conditions_note TEXT,
  issued_at       TEXT,
  accepted_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (chain_id, revision_number)
);

CREATE INDEX quote_revisions_by_chain ON quote_revisions(chain_id, revision_number DESC);

-- Exactly one accepted revision per quote chain.
CREATE UNIQUE INDEX quote_revisions_single_accepted
  ON quote_revisions(chain_id)
  WHERE status = 'accepted';

-- ---------------------------------------------------------------------------
-- 2. Phase 2: Orders & Order Status FSM
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  quote_chain_id      TEXT NOT NULL UNIQUE REFERENCES quote_chains(id),
  accepted_revision_id TEXT NOT NULL UNIQUE REFERENCES quote_revisions(id),
  customer_id         TEXT NOT NULL REFERENCES customers(id),
  order_code          TEXT NOT NULL UNIQUE,
  total_vnd           INTEGER NOT NULL CHECK (total_vnd >= 0),
  deposit_required_vnd INTEGER NOT NULL CHECK (deposit_required_vnd >= 0),
  pilot_credit_applied_vnd INTEGER NOT NULL DEFAULT 0 CHECK (pilot_credit_applied_vnd >= 0),
  collected_vnd       INTEGER NOT NULL DEFAULT 0 CHECK (collected_vnd >= 0),
  refund_owed_vnd     INTEGER NOT NULL DEFAULT 0 CHECK (refund_owed_vnd >= 0),
  status              TEXT NOT NULL CHECK (status IN ('pending_deposit', 'deposit_confirmed', 'processing', 'scheduled', 'delivered', 'cancelled')),
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (collected_vnd <= total_vnd)
);

CREATE INDEX orders_by_workspace ON orders(workspace_id, created_at DESC);
CREATE INDEX orders_by_status ON orders(status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Phase 2: Receipts & Immutable Audit Events
-- ---------------------------------------------------------------------------

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

CREATE INDEX receipt_events_by_receipt ON receipt_events(receipt_id, created_at ASC);

-- ---------------------------------------------------------------------------
-- 4. Phase 2: Delivery Tasks & Follow-up
-- ---------------------------------------------------------------------------

CREATE TABLE deliveries (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  order_id              TEXT NOT NULL UNIQUE REFERENCES orders(id),
  scheduled_date        TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('scheduled', 'in_transit', 'delivered', 'failed', 'cancelled')),
  delivery_address      TEXT NOT NULL,
  under_deposit_override INTEGER NOT NULL DEFAULT 0 CHECK (under_deposit_override IN (0, 1)),
  override_reason       TEXT,
  override_by           TEXT REFERENCES identities(id),
  assigned_to           TEXT,
  note                  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

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

CREATE INDEX follow_up_tasks_by_due ON follow_up_tasks(workspace_id, status, due_date);

-- ---------------------------------------------------------------------------
-- 5. Phase 3: Founder Interviews & Observations
-- ---------------------------------------------------------------------------

CREATE TABLE founder_interviews (
  id                  TEXT PRIMARY KEY,
  external_id         TEXT NOT NULL UNIQUE,
  organization_alias  TEXT NOT NULL,
  respondent_role     TEXT NOT NULL,
  interviewed_at      TEXT NOT NULL,
  data_origin         TEXT NOT NULL CHECK (data_origin IN ('synthetic', 'real')),
  notes               TEXT,
  recorded_by         TEXT NOT NULL REFERENCES identities(id),
  revision            INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX founder_interviews_by_date ON founder_interviews(interviewed_at DESC);

CREATE TABLE founder_observations (
  id              TEXT PRIMARY KEY,
  interview_id    TEXT NOT NULL REFERENCES founder_interviews(id),
  metric_key      TEXT NOT NULL CHECK (
    metric_key IN (
      'pilot_fee_vnd',
      'setup_fee_vnd',
      'monthly_fee_vnd',
      'direct_cost_per_customer_month_vnd',
      'direct_cost_per_setup_vnd',
      'fixed_cost_per_month_vnd',
      'founder_hourly_value_vnd',
      'support_hours_per_customer_month',
      'setup_hours_per_customer',
      'sales_hours_per_month',
      'maintenance_hours_per_month',
      'admin_hours_per_month',
      'buffer_hours_per_month',
      'capacity_hours_per_month',
      'minimum_benefit_cost_ratio',
      'willingness_to_pay_vnd'
    )
  ),
  value_num       REAL,
  value_str       TEXT,
  unit            TEXT NOT NULL,
  period          TEXT,
  evidence_kind   TEXT NOT NULL CHECK (evidence_kind IN ('reported', 'measured', 'assumption')),
  source_ref      TEXT,
  is_null         INTEGER NOT NULL DEFAULT 0 CHECK (is_null IN (0, 1)),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at      TEXT NOT NULL
);

CREATE INDEX founder_obs_by_interview ON founder_observations(interview_id, metric_key);

-- ---------------------------------------------------------------------------
-- 6. Phase 3: Change Proposals & Immutable Config Versions
-- ---------------------------------------------------------------------------

CREATE TABLE config_versions (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('business_model', 'workspace_operations')),
  workspace_id    TEXT REFERENCES workspaces(id),
  version_number  INTEGER NOT NULL CHECK (version_number >= 1),
  parameters_json TEXT NOT NULL,
  proposal_id     TEXT,
  created_by      TEXT NOT NULL REFERENCES identities(id),
  created_at      TEXT NOT NULL,
  UNIQUE (scope, workspace_id, version_number)
);

CREATE TABLE active_config_pointers (
  scope           TEXT NOT NULL CHECK (scope IN ('business_model', 'workspace_operations')),
  workspace_id    TEXT NOT NULL,
  active_version_id TEXT NOT NULL REFERENCES config_versions(id),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (scope, workspace_id)
);

CREATE TABLE change_proposals (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('business_model', 'workspace_operations')),
  workspace_id    TEXT REFERENCES workspaces(id),
  base_version_id TEXT REFERENCES config_versions(id),
  changes_json    TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'applied')),
  proposed_by     TEXT NOT NULL REFERENCES identities(id),
  approved_by     TEXT REFERENCES identities(id),
  approved_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX change_proposals_by_scope ON change_proposals(scope, status);

-- ---------------------------------------------------------------------------
-- 7. Phase 3: OPC Agreements, Obligations, Pilot Credit & Receipts
-- ---------------------------------------------------------------------------

CREATE TABLE opc_agreements (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  status              TEXT NOT NULL CHECK (status IN ('draft', 'active', 'terminated')),
  monthly_fee_vnd     INTEGER NOT NULL CHECK (monthly_fee_vnd >= 0),
  setup_fee_vnd       INTEGER NOT NULL CHECK (setup_fee_vnd >= 0),
  effective_date      TEXT NOT NULL,
  termination_date    TEXT,
  price_plane_snapshot_json TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE opc_obligations (
  id              TEXT PRIMARY KEY,
  agreement_id    TEXT NOT NULL REFERENCES opc_agreements(id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  obligation_kind TEXT NOT NULL CHECK (obligation_kind IN ('pilot_fee', 'setup_fee', 'monthly_subscription', 'service_fee')),
  amount_vnd      INTEGER NOT NULL CHECK (amount_vnd > 0),
  due_date        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'partially_settled', 'settled', 'cancelled')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX opc_obligations_by_agreement ON opc_obligations(agreement_id, status);

CREATE TABLE opc_receipts (
  id              TEXT PRIMARY KEY,
  agreement_id    TEXT NOT NULL REFERENCES opc_agreements(id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  obligation_id   TEXT REFERENCES opc_obligations(id),
  amount_vnd      INTEGER NOT NULL CHECK (amount_vnd > 0),
  fee_type        TEXT NOT NULL CHECK (fee_type IN ('pilot_fee', 'setup_fee', 'monthly_subscription', 'upgrade_fee', 'other')),
  reference       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'reversed')),
  confirmed_by    TEXT REFERENCES identities(id),
  confirmed_at    TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX opc_receipts_by_agreement ON opc_receipts(agreement_id, status);

CREATE TABLE pilot_credits (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  pilot_receipt_id  TEXT NOT NULL UNIQUE REFERENCES opc_receipts(id),
  credit_amount_vnd INTEGER NOT NULL CHECK (credit_amount_vnd > 0),
  applied_to_obligation_id TEXT REFERENCES opc_obligations(id),
  applied_at        TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX pilot_credits_by_workspace ON pilot_credits(workspace_id);
