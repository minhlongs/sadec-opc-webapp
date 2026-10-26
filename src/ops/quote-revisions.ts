/**
 * The quote revision state machine and the arithmetic behind it.
 *
 * Everything here is pure: it takes values, returns values, and touches no
 * database. The invariants §7.2 and §7.3 state about quoting therefore live
 * where a unit test can reach them without a fixture, and the D1 access that
 * persists a revision is a separate module that calls into this one.
 *
 * One rule governs every function below: the server computes the total. A value
 * arriving in a request body is never the value that persists.
 */

import { addVnd, basisPointsOf, multiplyByBasisPoints } from '../domain/money.ts';

/** The states a quote revision moves through. */
export const QUOTE_REVISION_STATUSES = [
  'draft',
  'issued',
  'accepted',
  'declined',
  'expired',
  'superseded',
] as const;

export type QuoteRevisionStatus = (typeof QUOTE_REVISION_STATUSES)[number];

/** The states an order moves through. */
export const ORDER_STATUSES = [
  'pending_deposit',
  'deposit_confirmed',
  'processing',
  'scheduled',
  'delivered',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const RECEIPT_STATUSES = ['pending', 'confirmed', 'reversed'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const DELIVERY_STATUSES = [
  'scheduled',
  'in_transit',
  'delivered',
  'failed',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const FOLLOW_UP_KINDS = [
  'deposit_reminder',
  'delivery_confirm',
  'quality_check',
  'repeat_order',
] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

export const TASK_STATUSES = ['open', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * A quote line frozen at issue time.
 *
 * The unit price is a snapshot of what the product table said when the revision
 * was issued, so a later price change cannot move a quote the customer already
 * holds.
 */
export interface QuoteLine {
  product_id: string;
  product_name: string;
  unit: string;
  unit_price_vnd: number;
  quantity: number;
  line_total_vnd: number;
  note: string | null;
}

/**
 * A line a caller wants priced, with the product fields already resolved.
 *
 * The caller resolves the product rather than passing an id, because resolving
 * is where a product that is unknown or inactive turns into a refusal, and a
 * refusal belongs to the function that knows the workspace.
 */
export interface PriceableLine {
  product_id: string;
  product_name: string;
  unit: string;
  unit_price_vnd: number;
  quantity: number;
  discount_vnd?: number;
  note?: string | null;
}

/** A line as a client may send it, before any price is known. */
export interface QuoteLineInput {
  product_id?: string;
  product_name?: string;
  unit?: string;
  unit_price_vnd?: number;
  quantity: number;
  discount_vnd?: number;
  note?: string | null;
}

export interface QuoteRevision {
  id: string;
  chain_id: string;
  workspace_id: string;
  revision_number: number;
  status: QuoteRevisionStatus;
  lines: QuoteLine[];
  subtotal_vnd: number;
  discount_vnd: number;
  fees_vnd: number;
  total_vnd: number;
  valid_until: string | null;
  conditions_note: string | null;
  issued_at: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Caps a discount at the amount it is discounting. */
function capDiscount(discountVnd: number, grossVnd: number): number {
  if (discountVnd <= 0) return 0;
  return discountVnd > grossVnd ? grossVnd : discountVnd;
}

function multiplyVnd(unitPriceVnd: number, quantity: number): number {
  const product = unitPriceVnd * quantity;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(
      `Line total for ${quantity} × ${unitPriceVnd} is outside the safe integer range`,
    );
  }
  return product;
}

/**
 * Prices lines, capping each line's discount at that line.
 *
 * A discount larger than the line it discounts is a data error that would
 * otherwise silently reduce an unrelated line, so the cap is per line rather
 * than against the whole quote.
 */
export function priceLines(lines: PriceableLine[]): QuoteLine[] {
  return lines.map((line) => {
    const gross = multiplyVnd(line.unit_price_vnd, line.quantity);
    const capped = capDiscount(line.discount_vnd ?? 0, gross);
    return {
      product_id: line.product_id,
      product_name: line.product_name,
      unit: line.unit,
      unit_price_vnd: line.unit_price_vnd,
      quantity: line.quantity,
      line_total_vnd: addVnd(gross, -capped),
      note: line.note ?? null,
    };
  });
}

/** Sums the line totals, which already carry their own discounts. */
export function subtotalOfLines(lines: QuoteLine[]): number {
  return lines.reduce((sum, line) => addVnd(sum, line.line_total_vnd), 0);
}

/**
 * The total the server states for a revision.
 *
 * A discount and fees arriving in a request are combined here rather than in a
 * route, so there is one place that decides the order and no second one that a
 * later edit can get half-right.
 */
export function totalOfRevision(
  subtotalVnd: number,
  discountVnd: number,
  feesVnd: number,
): number {
  const capped = capDiscount(discountVnd, subtotalVnd);
  return addVnd(addVnd(subtotalVnd, -capped), feesVnd);
}

/**
 * The deposit an order requires, in dong.
 *
 * The rate is basis points so no float percentage reaches this arithmetic, and
 * the multiplication truncates once rather than rounding a share above what the
 * total permits.
 */
export function depositRequired(totalVnd: number, depositRateBps: number): number {
  return multiplyByBasisPoints(totalVnd, basisPointsOf(depositRateBps / 100));
}

/**
 * The order state machine, as data.
 *
 * A transition not listed here is refused rather than attempted, because
 * validating transitions server-side is exactly the rule an `if` chain in a
 * handler quietly loses.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending_deposit: ['deposit_confirmed', 'cancelled'],
  deposit_confirmed: ['processing', 'cancelled'],
  processing: ['scheduled', 'cancelled'],
  scheduled: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] as readonly OrderStatus[]).includes(to);
}
