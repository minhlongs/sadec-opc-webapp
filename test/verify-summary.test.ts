import { describe, expect, it } from 'vitest';
import { parseFileCount, parseTestCount, stripAnsi } from '../scripts/verify-summary.ts';

/**
 * The verify gate reads vitest's own summary line to prove tests ran. The
 * baseline run on 2026-10-29 showed `pnpm verify` failing a green 220-test
 * suite because the captured output carried ANSI colour codes and the count
 * read back as null. These cases pin both shapes of the line.
 */

const ESC = '\u001b[';

/** The summary as vitest prints it to a non-TTY. */
const PLAIN = `
 Test Files  22 passed (22)
      Tests  220 passed (220)
   Start at  15:03:12
   Duration  4.21s
`;

/** The same summary as a TTY receives it, colours and all. */
const COLOURED = `
 ${ESC}2mTest Files${ESC}22m  ${ESC}1m${ESC}32m22 passed${ESC}39m${ESC}22m${ESC}90m (22)${ESC}39m
      ${ESC}2mTests${ESC}22m  ${ESC}1m${ESC}32m220 passed${ESC}39m${ESC}22m${ESC}90m (220)${ESC}39m
   ${ESC}2mStart at${ESC}22m  15:03:12
`;

describe('reading the vitest summary', () => {
  it('reads the counts from plain output', () => {
    expect(parseTestCount(PLAIN)).toBe(220);
    expect(parseFileCount(PLAIN)).toBe(22);
  });

  it('reads the same counts when the output is coloured', () => {
    expect(parseTestCount(COLOURED)).toBe(220);
    expect(parseFileCount(COLOURED)).toBe(22);
  });

  it('prefers the parenthesised total, which counts every test that ran', () => {
    const mixed = ' Test Files  3 passed (3)\n      Tests  7 passed | 1 skipped (8)\n';
    expect(parseTestCount(mixed)).toBe(8);
  });

  it('reads nothing from output with no summary, so the gate fails rather than passes', () => {
    expect(parseTestCount('No test files found, exiting with code 1')).toBeNull();
    expect(parseFileCount('')).toBeNull();
  });

  it('strips only escape sequences and keeps the text intact', () => {
    expect(stripAnsi(`${ESC}31mlỗi${ESC}0m 1,234`)).toBe('lỗi 1,234');
    expect(parseTestCount(' Tests  1,234 passed (1,234)')).toBe(1234);
  });
});
