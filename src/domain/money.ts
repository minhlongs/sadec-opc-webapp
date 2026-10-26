/**
 * Money is a VND integer. §7.2 forbids relying on arbitrary float arithmetic for
 * money, so every value that reaches the ledger passes through here.
 */

/** The largest magnitude we will carry, leaving headroom inside a JS safe integer. */
export const MAX_VND = Number.MAX_SAFE_INTEGER - 1_000_000;

function isFiniteNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: number): boolean {
  return Number.isInteger(value);
}

/**
 * Truncates toward zero to a whole dong. See docs/DECISIONS.md for why it
 * truncates rather than rounds, and why this is the only place it happens.
 */
export function truncateToDong(value: number): number {
  if (!isFiniteNumber(value)) {
    throw new RangeError(
      `Cannot truncate a value that is not a finite number: ${value}`,
    );
  }
  return Math.trunc(value);
}

/**
 * Asserts a value is a whole VND amount inside the safe bound, and returns it.
 * Used at every boundary where a number is about to become money.
 */
export function assertSafeVnd(value: number): number {
  if (!isFiniteNumber(value)) {
    throw new RangeError(
      `VND amount is not a finite number: ${String(value)}`,
    );
  }
  if (!isInteger(value)) {
    throw new RangeError(
      `VND amount must be an integer, received a fractional amount: ${value}`,
    );
  }
  if (Math.abs(value) > MAX_VND) {
    throw new RangeError(
      `VND amount exceeds the safe bound of ${MAX_VND}: ${value}`,
    );
  }
  return value;
}

/**
 * Rejects a float where money is expected, rather than rounding it in silently.
 */
export function vndFromUnsafeNumber(value: number): number {
  return assertSafeVnd(value);
}

/** Reads a percentage into basis points, which is how rates are stored. §7.2 */
export function basisPointsOf(percent: number): number {
  if (!isFiniteNumber(percent) || percent < 0) {
    throw new RangeError(
      `A rate must be a finite, non-negative percentage: ${String(percent)}`,
    );
  }
  const bps = percent * 100;
  if (!isInteger(bps)) {
    throw new RangeError(
      `A rate must be expressible in whole basis points: ${percent}%`,
    );
  }
  if (bps > 10_000) {
    throw new RangeError(`A rate cannot exceed 100%: ${percent}%`);
  }
  return bps;
}

/**
 * Multiplies an amount by a basis-point rate and truncates the result, so a
 * share is never rounded above what the amount actually permits.
 */
export function multiplyByBasisPoints(amountVnd: number, bps: number): number {
  assertSafeVnd(amountVnd);
  if (amountVnd < 0) {
    throw new RangeError(`Amount cannot be negative: ${amountVnd}`);
  }
  if (!isFiniteNumber(bps) || bps < 0) {
    throw new RangeError(
      `Rate in basis points cannot be negative: ${String(bps)}`,
    );
  }
  if (bps > 10_000) {
    throw new RangeError(`Rate cannot exceed 100%: ${bps} basis points`);
  }
  return truncateToDong((amountVnd * bps) / 10_000);
}

/** Adds two VND amounts, refusing to wrap around silently. */
export function addVnd(leftVnd: number, rightVnd: number): number {
  assertSafeVnd(leftVnd);
  assertSafeVnd(rightVnd);
  const sum = leftVnd + rightVnd;
  if (!isFiniteNumber(sum) || Math.abs(sum) > MAX_VND) {
    throw new RangeError(
      `Adding ${leftVnd} and ${rightVnd} cannot exceed the safe bound of ${MAX_VND}`,
    );
  }
  return sum;
}

export function formatVnd(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatVndWithUnit(amount: number): string {
  return `${formatVnd(amount)} ₫`;
}

