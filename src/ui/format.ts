/**
 * Presentation helpers, kept out of the domain module on purpose.
 *
 * The domain decides money arithmetically and truncates once at its own boundary
 * (`src/domain/money.ts`). This file formats an amount that has already been
 * decided — it never computes one. That separation is why a quote total is never
 * optimistic about what a customer is asked to pay: the number is fixed before
 * it reaches here, and all that happens next is punctuation.
 */

/**
 * Formats a whole number of dong with a thousands separator.
 *
 * `Intl` with an explicit `vi-VN` locale rather than a manual regex, because a
 * hand-rolled grouping loop is where an off-by-one in a decimal separator
 * becomes a quote that reads as ten times its value.
 */
export function formatVnd(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Money with its unit attached, so a column of bare numbers has a caption. */
export function formatVndWithUnit(amount: number): string {
  return `${formatVnd(amount)} đ`;
}

/**
 * Distinguishes "not entered" from "zero", which §5 says must not read alike.
 *
 * A field that was never filled in is not a field holding 0 — one means the
 * workspace has no data yet, the other means it has a measured nothing.
 */
export function formatOptionalVnd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return 'Chưa nhập';
  return formatVndWithUnit(amount);
}

/** A human-readable timestamp, or a plain statement when there is none. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'Chưa nhập';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}
