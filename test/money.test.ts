import { describe, expect, it } from 'vitest';
import {
  MAX_VND,
  addVnd,
  assertSafeVnd,
  basisPointsOf,
  multiplyByBasisPoints,
  truncateToDong,
  vndFromUnsafeNumber,
} from '../src/domain/money.js';

describe('truncateToDong', () => {
  it('drops the fractional part rather than rounding it', () => {
    expect(truncateToDong(3_833_333.33)).toBe(3_833_333);
    expect(truncateToDong(3_833_333.99)).toBe(3_833_333);
  });

  it('leaves an integer untouched', () => {
    expect(truncateToDong(11_500_000)).toBe(11_500_000);
    expect(truncateToDong(-3_050_000)).toBe(-3_050_000);
  });

  it('truncates toward zero, so a small negative keeps its sign', () => {
    expect(truncateToDong(-0.5)).toBe(-0);
    expect(truncateToDong(-3_050_000.5)).toBe(-3_050_000);
  });

  it('refuses to round a value that is not a number at all', () => {
    expect(() => truncateToDong(Number.NaN)).toThrow(/not a finite number/i);
    expect(() => truncateToDong(Number.POSITIVE_INFINITY)).toThrow(
      /not a finite number/i,
    );
  });
});

describe('assertSafeVnd', () => {
  it('accepts every amount the business uses', () => {
    expect(assertSafeVnd(0)).toBe(0);
    expect(assertSafeVnd(50_000_000)).toBe(50_000_000);
    expect(assertSafeVnd(-3_050_000)).toBe(-3_050_000);
  });

  it('refuses a fractional amount rather than rounding it into the ledger', () => {
    expect(() => assertSafeVnd(1_000.5)).toThrow(/integer/i);
  });

  it('refuses a value above the safe integer bound', () => {
    expect(() => assertSafeVnd(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /exceeds/i,
    );
  });

  it('refuses NaN and Infinity', () => {
    expect(() => assertSafeVnd(Number.NaN)).toThrow(/not a finite number/i);
    expect(() => assertSafeVnd(Number.NEGATIVE_INFINITY)).toThrow(
      /not a finite number/i,
    );
  });
});

describe('vndFromUnsafeNumber', () => {
  it('refuses a float rather than silently accepting it', () => {
    expect(() => vndFromUnsafeNumber(3_000_000.4)).toThrow(/integer/i);
  });

  it('accepts an integer and returns it unchanged', () => {
    expect(vndFromUnsafeNumber(3_000_000)).toBe(3_000_000);
  });
});

describe('basisPointsOf', () => {
  it('reads a percentage into basis points', () => {
    expect(basisPointsOf(30)).toBe(3_000);
    expect(basisPointsOf(0)).toBe(0);
    expect(basisPointsOf(100)).toBe(10_000);
  });

  it('refuses a rate above one hundred percent', () => {
    expect(() => basisPointsOf(100.5)).toThrow(/cannot exceed/i);
  });
});

describe('multiplyByBasisPoints', () => {
  it('computes a deposit share exactly', () => {
    // 50,000,000 at 30% is 15,000,000
    expect(multiplyByBasisPoints(50_000_000, basisPointsOf(30))).toBe(15_000_000);
  });

  it('truncates a non-integer share toward zero, never up', () => {
    // 100,001 at 30% is 30,000.3
    expect(multiplyByBasisPoints(100_001, basisPointsOf(30))).toBe(30_000);
  });

  it('refuses a negative amount', () => {
    expect(() => multiplyByBasisPoints(-1, basisPointsOf(30))).toThrow(
      /negative/i,
    );
  });

  it('refuses a negative rate', () => {
    expect(() => multiplyByBasisPoints(1_000, -1)).toThrow(/negative/i);
  });
});

describe('addVnd', () => {
  it('adds and keeps the result an integer', () => {
    expect(addVnd(1_000, 2_000)).toBe(3_000);
  });

  it('throws on overflow so no silent wraparound reaches a total', () => {
    expect(() => addVnd(MAX_VND, 1)).toThrow(/cannot exceed/i);
  });

  it('rejects an input that is already outside the safe bound', () => {
    // The guard runs before the addition, so an out-of-bound input never reaches
    // the arithmetic.
    expect(() => addVnd(Number.MIN_SAFE_INTEGER, -1)).toThrow(/exceeds/i);
  });
});
