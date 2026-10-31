import { describe, expect, it } from 'vitest';
import { compareLedger, describeLedger, parseLedgerRows } from '../scripts/migration-ledger.ts';

/**
 * The conflict check that stands in front of an irreversible migration.
 *
 * Two failure modes are dangerous in opposite directions, and both are tested:
 * treating an unreadable ledger as empty (which would report every migration as
 * pending and let a migration run against a database nobody understands), and
 * missing an applied migration whose file this tree does not have (which is the
 * conflict the check exists for).
 */

function wranglerOutput(names: readonly string[]): string {
  return [
    '⛅️ wrangler 4.152.0',
    '──────────────────────',
    JSON.stringify([{ results: names.map((name) => ({ name })), success: true, meta: {} }]),
    '',
  ].join('\n');
}

describe('parseLedgerRows', () => {
  it('reads the names out of the array that follows wrangler’s banner', () => {
    expect(parseLedgerRows(wranglerOutput(['0001_a.sql', '0002_b.sql']))).toEqual([
      '0001_a.sql',
      '0002_b.sql',
    ]);
  });

  it('refuses output with no JSON array instead of returning an empty ledger', () => {
    // An empty ledger would read as "this database has never been migrated",
    // which is the one wrong answer that makes the check below dangerous.
    expect(() => parseLedgerRows('Error: something went wrong')).toThrow(/no JSON array/);
  });

  it('refuses an empty array, which describes no database at all', () => {
    expect(() => parseLedgerRows('[]')).toThrow(/not a non-empty array/);
  });

  it('refuses a zero-row result, which means the ledger table is empty', () => {
    expect(() => parseLedgerRows('[{ "results": [], "success": true }]')).toThrow(/never been migrated/);
  });

  it('refuses a row with no name rather than inventing one', () => {
    expect(() => parseLedgerRows('[{ "results": [{ "id": 1 }] }]')).toThrow(/no name/);
  });
});

describe('compareLedger', () => {
  const local = ['0001_a.sql', '0002_b.sql', '0003_c.sql'];

  it('reports nothing when the ledger is behind by exactly the pending files', () => {
    const comparison = compareLedger(local, ['0001_a.sql', '0002_b.sql']);
    expect(comparison.unknownApplied).toEqual([]);
    expect(comparison.pending).toEqual(['0003_c.sql']);
  });

  it('reports a conflict when an applied migration has no file in this tree', () => {
    const comparison = compareLedger(local, ['0001_a.sql', '0009_gone.sql']);
    expect(comparison.unknownApplied).toEqual(['0009_gone.sql']);
  });

  it('treats a renamed applied migration as a conflict, not as pending', () => {
    // The id is what the ledger records; a rename leaves the old name applied and
    // the new name pending, and that pair cannot be reproduced from this tree.
    const comparison = compareLedger(['0001_a-renamed.sql'], ['0001_a.sql']);
    expect(comparison.unknownApplied).toEqual(['0001_a.sql']);
    expect(comparison.pending).toEqual(['0001_a-renamed.sql']);
  });

  it('sorts the tree’s files so the pending list is the migration order', () => {
    const comparison = compareLedger(['0003_c.sql', '0001_a.sql', '0002_b.sql'], []);
    expect(comparison.pending).toEqual(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
  });

  it('is a pass when both sides match exactly', () => {
    const comparison = compareLedger(local, local);
    expect(comparison.unknownApplied).toEqual([]);
    expect(comparison.pending).toEqual([]);
  });
});

describe('describeLedger', () => {
  it('names the conflicting files and says why editing an applied migration is refused', () => {
    const lines = describeLedger(compareLedger(['0001_a.sql'], ['0001_a.sql', '0009_gone.sql'])).join('\n');
    expect(lines).toContain('CONFLICT');
    expect(lines).toContain('0009_gone.sql');
    expect(lines).toContain('never be edited');
  });

  it('prints exactly what a migration would run when nothing conflicts', () => {
    const lines = describeLedger(compareLedger(['0001_a.sql', '0002_b.sql'], ['0001_a.sql'])).join('\n');
    expect(lines).not.toContain('CONFLICT');
    expect(lines).toContain('0002_b.sql');
  });

  it('says so plainly when there is nothing to do', () => {
    const lines = describeLedger(compareLedger(['0001_a.sql'], ['0001_a.sql'])).join('\n');
    expect(lines).toContain('Nothing is pending');
  });
});
