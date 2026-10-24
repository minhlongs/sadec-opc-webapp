import { addVnd, assertSafeVnd, truncateToDong } from './money.ts';
import {
  assertValidParameters,
  type BusinessModelParameters,
} from './parameters.js';

/**
 * A metric that cannot be computed. §13: "Nếu thiếu dữ liệu thì không tính bừa.
 * Nếu mẫu số bằng 0, hiển thị không xác định và lý do."
 *
 * A missing input produces this rather than a zero, because a zero would read as
 * a measurement and an undefined reads as what it is.
 */
export type MaybeMetric<T> = { kind: 'value'; value: T } | { kind: 'undefined'; reason: string };

export function undefinedBecause(reason: string): MaybeMetric<never> {
  return { kind: 'undefined', reason };
}

function isUndefined<T>(m: MaybeMetric<T>): m is { kind: 'undefined'; reason: string } {
  return m.kind === 'undefined';
}

export interface ScenarioResult {
  /** N — existing monthly subscribers. */
  customers: number;
  /** S — new setups in the period. */
  new_setups: number;
  revenue_vnd: number;
  cash_cost_vnd: number;
  cash_surplus_vnd: number;
  hours: number;
  founder_value_vnd: number;
  economic_remainder_vnd: number;
  capacity_utilization: MaybeMetric<number>;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative integer, received: ${String(value)}`,
    );
  }
}

export function scenarioRevenue(
  p: BusinessModelParameters,
  customers: number,
  newSetups: number,
): number {
  return customers * p.monthly_fee_vnd + newSetups * p.setup_fee_vnd;
}

export function scenarioCashCost(
  p: BusinessModelParameters,
  customers: number,
  newSetups: number,
): number {
  return (
    customers * p.direct_cost_per_customer_month_vnd +
    newSetups * p.direct_cost_per_setup_vnd +
    p.fixed_cost_per_month_vnd
  );
}

function scenarioHours(
  p: BusinessModelParameters,
  customers: number,
  newSetups: number,
): number {
  return (
    customers * p.support_hours_per_customer_month +
    newSetups * p.setup_hours_per_customer +
    p.sales_hours_per_month +
    p.maintenance_hours_per_month +
    p.admin_hours_per_month +
    p.buffer_hours_per_month
  );
}

/**
 * Founder hours valued at the configured hourly value.
 *
 * The product passes through assertSafeVnd because `hours` is a caller-supplied
 * number: a large value times the hourly rate leaves the safe-integer range, and
 * a float-silent result is exactly what §7.2 forbids reaching the ledger.
 */
export function founderValueOf(p: BusinessModelParameters, hours: number): number {
  assertSafeVnd(hours);
  return assertSafeVnd(hours * p.founder_hourly_value_vnd);
}

/** Cash surplus minus founder value, with overflow refused rather than wrapped. */
export function economicRemainder(
  cashSurplusVnd: number,
  founderValueVnd: number,
): number {
  assertSafeVnd(cashSurplusVnd);
  assertSafeVnd(founderValueVnd);
  return addVnd(cashSurplusVnd, -founderValueVnd);
}

/**
 * Utilization is undefined when capacity is zero. §13 requires capacity to be
 * greater than zero, and a zero denominator is reported rather than divided.
 */
export function capacityUtilization(
  p: BusinessModelParameters,
  hours: number,
): MaybeMetric<number> {
  if (p.capacity_hours_per_month <= 0) {
    return undefinedBecause(
      'capacity_hours_per_month is zero, so utilization has no denominator',
    );
  }
  return { kind: 'value', value: hours / p.capacity_hours_per_month };
}

/** §13's first-year average cost, truncated to the dong. See docs/DECISIONS.md. */
export function firstYearAverageCost(p: BusinessModelParameters): number {
  return truncateToDong(p.monthly_fee_vnd + p.setup_fee_vnd / 12);
}

/**
 * §13's target benefit. The benefit ratio multiplies the exact average, and only
 * the result is truncated, which is why this lands on a whole number.
 */
export function targetBenefitOfCustomer(p: BusinessModelParameters): number {
  return truncateToDong(
    (p.monthly_fee_vnd + p.setup_fee_vnd / 12) * p.minimum_benefit_cost_ratio,
  );
}

/**
 * The one scenario function. §15 case 14 requires that changing an input
 * recomputes from the same domain function, so no screen may re-derive these
 * numbers, and no screen may carry its own copy of a formula.
 *
 * Hours are whole numbers, because every hour input is a whole number of hours
 * per customer or per month.
 */
export function computeScenario(
  parameters: BusinessModelParameters,
  customers: number,
  newSetups: number,
): ScenarioResult {
  assertValidParameters(parameters);
  assertNonNegativeInteger('customers', customers);
  assertNonNegativeInteger('new_setups', newSetups);

  const revenue = assertSafeVnd(
    scenarioRevenue(parameters, customers, newSetups),
  );
  const cashCost = assertSafeVnd(
    scenarioCashCost(parameters, customers, newSetups),
  );
  const cashSurplus = addVnd(revenue, -cashCost);
  const hours = scenarioHours(parameters, customers, newSetups);
  const founderValue = founderValueOf(parameters, hours);

  return {
    customers,
    new_setups: newSetups,
    revenue_vnd: revenue,
    cash_cost_vnd: cashCost,
    cash_surplus_vnd: cashSurplus,
    hours,
    founder_value_vnd: founderValue,
    economic_remainder_vnd: economicRemainder(cashSurplus, founderValue),
    capacity_utilization: capacityUtilization(parameters, hours),
  };
}

/** Formats a maybe-metric for display, keeping undefined visibly distinct. */
export function describeMetric(
  metric: MaybeMetric<number>,
  format: (value: number) => string,
): string {
  return isUndefined(metric) ? `Không xác định — ${metric.reason}` : format(metric.value);
}
