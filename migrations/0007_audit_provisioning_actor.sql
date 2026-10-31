-- ---------------------------------------------------------------------------
-- 0007: an audit actor that is not an identity
--
-- The first founder cannot be granted by the founder: before the grant there is
-- no identity holding `founder_admin`, and faking one would be a lie inside the
-- table the product uses to prove who did what. The grant is therefore performed
-- by a person with infrastructure access, running `pnpm bootstrap:founder`
-- against the database — outside the HTTP surface, and outside the identity
-- table.
--
-- `audit_events.actor_id` already allows NULL, so such a row could be written
-- without this migration. What it could not express is *why* the actor is
-- missing: "granted by a provisioning command" and "we lost the actor" would
-- look identical, and the second is exactly the kind of gap an audit trail is
-- supposed to make impossible.
--
-- `actor_source` records where the operation came from:
--
--   'app'           an authenticated request; `actor_id` names the identity
--   'provisioning'  the bootstrap command run by an operator; `actor_id` is NULL
--
-- The default is 'app', so every existing row keeps its meaning and every
-- existing insert in `src/**` is unchanged. The CHECK makes the vocabulary
-- closed: a future writer cannot invent a third source without a migration,
-- which is the point of putting it in the schema instead of a comment.
--
-- This is additive and idempotent-safe to apply to a database that already has
-- audit history: the column is NOT NULL with a constant default, so SQLite fills
-- it for every existing row.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_events ADD COLUMN actor_source TEXT NOT NULL DEFAULT 'app'
  CHECK (actor_source IN ('app', 'provisioning'));

-- Provisioning rows are read by action and source together ("what did the
-- bootstrap do to this database?"), and the audit trail is append-only, so this
-- index earns its space as soon as the second bootstrap runs.
CREATE INDEX audit_events_by_source ON audit_events(actor_source, created_at DESC);
