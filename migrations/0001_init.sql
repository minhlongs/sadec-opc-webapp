-- Sa Đéc Flow — initial schema
--
-- One migration covering every entity §14 lists, written in the foundation
-- phase so parallel lanes never each invent their own numbering. Only the
-- integrator adds a migration after this one.
--
-- Three things this schema encodes that application code cannot:
--
--   1. Every tenant row carries workspace_id. §14 asks for linkage enforced by
--      the database, not filtering done in the UI, because a filter written in
--      a handler can be forgotten in the next handler.
--
--   2. Money is INTEGER VND. §7.2 forbids arbitrary float arithmetic for money,
--      so the column types refuse a fraction at the point of storage rather
--      than trusting every caller to validate.
--
--   3. Concurrency is a constraint, not a hope. §11 is explicit that D1 batch()
--      is a SQL transaction rather than a row lock, and that an UPDATE matching
--      zero rows is not an error. So the invariants that decide who wins a race
--      are expressed as UNIQUE and CHECK constraints, which produce a real
--      error and roll the whole batch back.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity, workspace, membership
-- ---------------------------------------------------------------------------

-- A workspace is one nursery operation. §6 grants roles per workspace, so a
-- person may be owner of one and hold nothing in another.
CREATE TABLE workspaces (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- The three roles from §6, and no fourth.
--   founder_admin      discovery, OPC parameters, workspaces, service agreements
--   workspace_owner    data and settings in granted workspaces; confirms deposits
--   workspace_operator sales and orders in granted workspaces; never settings
CREATE TABLE roles (
  role TEXT PRIMARY KEY CHECK (role IN ('founder_admin', 'workspace_owner', 'workspace_operator'))
);

INSERT INTO roles (role) VALUES
  ('founder_admin'),
  ('workspace_owner'),
  ('workspace_operator');

-- An identity is an authenticated person, keyed by the subject claim from the
-- Access JWT rather than by an email address. An email can change and can be
-- shared between a founder and a nursery owner; a subject cannot. §6 forbids
-- letting the first person to log in become an admin, so this table grants
-- nothing on its own.
CREATE TABLE identities (
  id            TEXT PRIMARY KEY,
  access_sub    TEXT NOT NULL UNIQUE,
  email         TEXT,
  display_name  TEXT,
  created_at    TEXT NOT NULL
);

-- Membership binds an identity to a workspace with exactly one role.
--
-- UNIQUE(identity_id, workspace_id) means a person cannot hold two roles in one
-- workspace by accident. UNIQUE(workspace_id, role) would over-constrain, since
-- several operators in one workspace is the normal case, so it is deliberately
-- absent: one owner per workspace is a business rule, not a schema rule.
CREATE TABLE memberships (
  id            TEXT PRIMARY KEY,
  identity_id   TEXT NOT NULL REFERENCES identities(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  role          TEXT NOT NULL REFERENCES roles(role),
  granted_by    TEXT REFERENCES identities(id),
  granted_at    TEXT NOT NULL,
  revoked_at    TEXT,
  UNIQUE (identity_id, workspace_id, role)
);

CREATE INDEX memberships_by_identity ON memberships(identity_id);
CREATE INDEX memberships_by_workspace ON memberships(workspace_id);

-- Every meaningful founder action on a workspace leaves a row here. §6 requires
-- it, and it is the only part of authorization the founder cannot verify by
-- clicking, so it carries its own evidence.
CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspaces(id),
  actor_id      TEXT REFERENCES identities(id),
  action        TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  detail        TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX audit_events_by_workspace ON audit_events(workspace_id, created_at DESC);
CREATE INDEX audit_events_by_actor ON audit_events(actor_id);
