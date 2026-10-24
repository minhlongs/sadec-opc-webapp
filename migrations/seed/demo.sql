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
