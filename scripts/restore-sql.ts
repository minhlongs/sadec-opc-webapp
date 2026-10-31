/**
 * The SQL transformations a restore needs, shared by both restore commands.
 *
 * These functions were written inside `db-restore-test.ts`, which restores into a
 * scratch binding of the *test* database. Restoring a **pilot** backup needs the
 * same two transformations — strip Wrangler's bookkeeping, order the drops — and a
 * second copy of them would be the kind of duplicate that drifts silently: one
 * copy learns about a new wrangler output form and the other does not, and the
 * difference only shows up during an incident.
 *
 * Moved here unchanged.
 */

/**
 * Strips Wrangler's own bookkeeping from a backup so it can be replayed.
 *
 * `wrangler d1 export` writes the schema, the data, and two internal tables:
 * `d1_migrations`, which records which migration files have been applied, and
 * `sqlite_sequence`, which records that ledger's counter. Neither is business
 * data. Wrangler creates the ledger for a fresh binding before the file is
 * applied, so replaying these rows collides on the primary key and the restore
 * fails with a constraint error that says nothing about what actually went
 * wrong.
 *
 * A restore should reproduce the data, not re-enact the source machine's
 * migration history, so those statements are dropped here. The migration that
 * put the schema in place is history; the rows are the thing worth recovering.
 */
export function stripMigrationLedger(sql: string): string {
  // Split on statement terminators so a multi-line CREATE is removed whole.
  const statements = sql
    .split(';\n')
    .map((statement) => statement.trim())
    .filter((statement) => {
      if (statement === '') return false;
      if (/^CREATE TABLE IF NOT EXISTS "d1_migrations"/.test(statement)) return false;
      if (/^INSERT INTO "d1_migrations"/.test(statement)) return false;
      // The sequence that counts the ledger is emitted as three parts: the reset,
      // the row for the ledger's counter, and — critically — a bare
      // `DELETE FROM sqlite_sequence` wrangler writes to clear the table before
      // reinserting. Dropping the INSERTs alone leaves that DELETE, and since the
      // ledger it belongs to is gone, SQLite never creates `sqlite_sequence` in the
      // replayed database: the restore then dies on "no such table:
      // sqlite_sequence" and reports a restorable backup as broken.
      if (/^DELETE FROM "?sqlite_sequence"?\b/i.test(statement)) return false;
      if (/^INSERT INTO "sqlite_sequence"/.test(statement)) return false;
      return true;
    });
  return `${statements.map((s) => `${s};\n`).join('')}`;
}

/**
 * Every table the replay creates, in an order that can be dropped safely.
 *
 * A child table references its parent, so a DROP that reaches the parent first
 * is refused by the foreign key — which is indistinguishable, from the outside,
 * from a broken backup. Children therefore go first.
 *
 * The order is read from the replay's own REFERENCES edges rather than written
 * out here or sorted: a table added to a migration but missing from a hand-kept
 * list silently survives the reset, the next run's CREATE TABLE collides, and a
 * restorable backup is reported as broken. Sorting by name is not enough either
 * — `workspaces` sorts after `quote_drafts` alphabetically, yet `quote_drafts`
 * references it.
 *
 * A cycle (or a reference to a table the replay does not create) is not an
 * order this can compute, so it is reported rather than guessed at.
 */
export function orderedForDrop(replaySql: string): string[] | string {
  const statements = [...replaySql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?(\w+)[^;]*;/gi)];

  const tables = new Set<string>();
  // parent → children, read straight off the REFERENCES edges. A table may only
  // be dropped once every table still standing has stopped referencing it.
  const referencedBy = new Map<string, string[]>();

  for (const match of statements) {
    const table = match[1];
    const body = match[0];
    if (table === undefined || body === undefined) continue;
    tables.add(table);

    for (const reference of body.matchAll(/REFERENCES\s+["`]?(\w+)/gi)) {
      const parent = reference[1];
      if (parent === undefined || parent === table) continue;
      referencedBy.set(parent, [...(referencedBy.get(parent) ?? []), table]);
    }
  }

  const ordered: string[] = [];
  const placed = new Set<string>();

  // Drop from the leaves inward: anything no unplaced table references is safe
  // next, because nothing standing can refuse the drop.
  while (ordered.length < tables.size) {
    const ready = [...tables]
      .filter((table) => !placed.has(table))
      .filter((table) => (referencedBy.get(table) ?? []).every((child) => placed.has(child)));

    if (ready.length === 0) {
      return `The replay references tables in a cycle: ${[...tables].filter((t) => !placed.has(t)).join(', ')}`;
    }
    for (const table of ready) {
      ordered.push(table);
      placed.add(table);
    }
  }

  return ordered;
}
