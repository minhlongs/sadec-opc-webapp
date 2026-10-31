-- 0006 — Config version lineage, and one uniqueness hole closed.
--
-- Why this migration exists
--
--   1. A rollback creates a new immutable version whose parameters copy an
--      older one. Until now the only record of *which* older one was the
--      `rolled_back_from` field inside the audit event's JSON detail. The
--      version row itself said nothing, so a list of versions could not show
--      "v3 restores v1" without parsing audit rows. `restored_from_version_id`
--      puts that link on the row, as a foreign key to the version it copies.
--
--   2. `config_versions` carries `UNIQUE (scope, workspace_id, version_number)`,
--      but for the global `business_model` scope `workspace_id` is NULL, and
--      SQLite treats every NULL as distinct in a UNIQUE constraint. Two
--      concurrent applies could therefore both insert "version 2" of the
--      business model. The application now gates every version insert on the
--      active pointer (see src/founder/discovery.ts), and this partial unique
--      index makes the database refuse the duplicate as well, in line with the
--      decision that money and configuration invariants live in the database.
--
-- Upgrade path
--
--   Additive. The column is nullable and backfilled from the audit events the
--   old rollback code wrote (`action = 'config.rollback'`, `subject_id` = the
--   new version, `detail.rolled_back_from` = the version it copied). A version
--   with no such event keeps NULL — nothing is guessed.
--
--   The unique index fails to build if a database already holds two global
--   versions with the same number. Check before applying anywhere that was
--   written to under the old code:
--
--     SELECT version_number, COUNT(*) FROM config_versions
--      WHERE scope = 'business_model' AND workspace_id IS NULL
--      GROUP BY version_number HAVING COUNT(*) > 1;
--
--   An empty result means the index applies cleanly. A non-empty result is a
--   data repair to be decided by a person, not by this file.

ALTER TABLE config_versions
  ADD COLUMN restored_from_version_id TEXT REFERENCES config_versions(id);

UPDATE config_versions
   SET restored_from_version_id = (
     SELECT json_extract(ae.detail, '$.rolled_back_from')
       FROM audit_events ae
      WHERE ae.action = 'config.rollback'
        AND ae.subject_type = 'config_version'
        AND ae.subject_id = config_versions.id
      ORDER BY ae.created_at DESC
      LIMIT 1
   )
 WHERE restored_from_version_id IS NULL
   AND EXISTS (
     SELECT 1 FROM audit_events ae
      WHERE ae.action = 'config.rollback'
        AND ae.subject_type = 'config_version'
        AND ae.subject_id = config_versions.id
        AND json_extract(ae.detail, '$.rolled_back_from') IN (SELECT id FROM config_versions)
   );

CREATE UNIQUE INDEX config_versions_global_version
  ON config_versions (scope, version_number)
  WHERE workspace_id IS NULL;
