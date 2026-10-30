import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards on the read-back half of `scripts/db-restore-test.ts`.
 *
 * These are static checks because the script itself shells out to `wrangler`;
 * running it here would need a live local D1 and would take seconds per test.
 * What they protect is a trap that a 2026-10-30 rehearsal fell into and that no
 * unit test could have caught from the outside: the local D1 build refuses more
 * than five `UNION ALL` terms with "too many terms in compound SELECT", so
 * widening the row-count list past five silently stopped the read-back while the
 * restore itself still succeeded and the script exited 0.
 */
const source = readFileSync('scripts/db-restore-test.ts', 'utf8');

/**
 * The script's prose explains the limit it avoids, so the word UNION appears in
 * comments on purpose. Strip comment lines before asserting anything about the
 * SQL the script actually builds.
 */
const code = source
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  })
  .join('\n');

describe('db:restore:test read-back', () => {
  it('counts the ten tables that carry the evidence, not the three that were easiest', () => {
    for (const table of [
      'workspaces',
      'identities',
      'memberships',
      'quote_revisions',
      'orders',
      'receipts',
      'receipt_events',
      'escrow_ledger_entries',
      'config_versions',
      'audit_events',
    ]) {
      expect(source).toContain(`'${table}',`);
    }
  });

  it('stays inside the compound-select limit by asking for one row of sub-selects', () => {
    expect(source).toContain('(SELECT COUNT(*) FROM ${table}) AS ${table}');
    expect(code).not.toContain('UNION');
  });

  it('fails the run when the read-back produced nothing', () => {
    // A restore that cannot be read back is an unproved restore. Exiting 0 there
    // would report success for the exact case this command exists to catch.
    expect(source).toContain('process.exit(probe.status ?? 1)');
  });
});
