/**
 * Does the remote migration ledger describe the tree that is about to migrate it?
 *
 * `wrangler d1 migrations list --remote` answers "what is not applied yet". That
 * is the wrong question before an irreversible step: the dangerous case is the
 * opposite one — a migration recorded as **applied** whose file this tree does not
 * have, because someone edited or deleted an applied migration, or checked out a
 * commit that never contained it. Wrangler would happily apply whatever is pending
 * on top of a ledger nobody can reproduce.
 *
 * So the check reads the ledger itself (`SELECT name FROM d1_migrations`) and
 * compares it with `migrations/*.sql`:
 *
 *   - **applied but not in the tree** — a conflict. Editing an applied migration
 *     is forbidden by §14 because the database already ran the old text; a
 *     deployment built from this tree cannot be reproduced from it.
 *   - **in the tree but not applied** — expected before a migration. Printed so the
 *     operator sees exactly what is about to run.
 *
 * The comparison is a pure function so it has tests without a database, and the
 * CLI (`scripts/db-migration-drift.ts`) only reads files.
 */

export interface LedgerComparison {
  /** Migration files in the tree, ordered as the migration runner orders them. */
  readonly local: readonly string[];
  /** Names recorded as applied, in ledger order. */
  readonly applied: readonly string[];
  /** Applied but absent from the tree. Non-empty is a refusal. */
  readonly unknownApplied: readonly string[];
  /** In the tree, not yet applied: what a migration would do. */
  readonly pending: readonly string[];
}

/**
 * Reads the `name` column out of `wrangler d1 execute --json` output.
 *
 * Wrangler prints a banner before the JSON array, so the array is located rather
 * than assumed to start at the first byte — the same tolerance
 * `scripts/bootstrap-founder.ts` uses, for the same reason. An unparseable
 * response throws: returning an empty ledger would read as "nothing has ever been
 * applied", which is the one wrong answer that makes this check dangerous.
 */
export function parseLedgerRows(text: string): string[] {
  const start = text.search(/^\[/m);
  if (start === -1) {
    throw new Error('no JSON array in the wrangler output');
  }
  const parsed: unknown = JSON.parse(text.slice(start));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('the wrangler output was not a non-empty array');
  }
  const first = parsed[0] as { results?: unknown };
  if (!Array.isArray(first.results)) {
    throw new Error('the first statement carried no results array');
  }
  const names = first.results.map((row) => {
    const name = (row as { name?: unknown }).name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('a ledger row had no name');
    }
    return name.trim();
  });
  if (names.length === 0) {
    throw new Error('the ledger is empty: this database has never been migrated');
  }
  return names;
}

/** Compares the tree's migration files with the applied names. */
export function compareLedger(
  localFiles: readonly string[],
  applied: readonly string[],
): LedgerComparison {
  const local = [...localFiles].sort();
  const localSet = new Set(local);
  const appliedSet = new Set(applied);
  return {
    local,
    applied: [...applied],
    unknownApplied: applied.filter((name) => !localSet.has(name)),
    pending: local.filter((name) => !appliedSet.has(name)),
  };
}

/** The report, as lines. `scripts/db-migration-drift.ts` prints these and exits. */
export function describeLedger(comparison: LedgerComparison): string[] {
  const lines: string[] = [
    `Migrations in this tree:   ${comparison.local.length}`,
    `Migrations applied:        ${comparison.applied.length}`,
  ];

  if (comparison.unknownApplied.length > 0) {
    lines.push(
      '',
      'CONFLICT — recorded as applied, but no file with that name exists here:',
      ...comparison.unknownApplied.map((name) => `  - ${name}`),
      '',
      'An applied migration must never be edited or removed: the database already',
      'ran the old text, so this tree cannot reproduce it. Check out the commit the',
      'migration came from, or restore the file, before migrating anything.',
    );
    return lines;
  }

  if (comparison.pending.length > 0) {
    lines.push(
      '',
      'Pending — in this tree, not yet applied. A migration would run exactly these:',
      ...comparison.pending.map((name) => `  - ${name}`),
    );
  } else {
    lines.push('', 'Nothing is pending: the database is already at this tree.');
  }

  return lines;
}
