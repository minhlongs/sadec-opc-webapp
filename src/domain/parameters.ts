import { assertSafeVnd } from './money.js';

/**
 * The OPC business model. §10 requires these to be a schema with values read
 * from configuration, never the same literal repeated across screens.
 *
 * Every one of these is an initial assumption about a business that has not been
 * interviewed yet, and the UI must label them that way.
 */
export interface BusinessModelParameters {
  pilot_fee_vnd: number;
  setup_fee_vnd: number;
  monthly_fee_vnd: number;
  direct_cost_per_customer_month_vnd: number;
  direct_cost_per_setup_vnd: number;
  fixed_cost_per_month_vnd: number;
  founder_hourly_value_vnd: number;
  support_hours_per_customer_month: number;
  setup_hours_per_customer: number;
  sales_hours_per_month: number;
  maintenance_hours_per_month: number;
  admin_hours_per_month: number;
  buffer_hours_per_month: number;
  capacity_hours_per_month: number;
  minimum_benefit_cost_ratio: number;
}

/**
 * Validates a parameter set at the boundary where it is loaded. A negative
 * price, cost or hour count is a configuration error, not a scenario to compute.
 */
export function assertValidParameters(
  parameters: BusinessModelParameters,
): BusinessModelParameters {
  for (const key of [
    'pilot_fee_vnd',
    'setup_fee_vnd',
    'monthly_fee_vnd',
    'direct_cost_per_customer_month_vnd',
    'direct_cost_per_setup_vnd',
    'fixed_cost_per_month_vnd',
    'founder_hourly_value_vnd',
  ] as const) {
    const value = parameters[key];
    if (value < 0) {
      throw new RangeError(`${key} cannot be negative: ${value}`);
    }
    assertSafeVnd(value);
  }
  for (const key of [
    'support_hours_per_customer_month',
    'setup_hours_per_customer',
    'sales_hours_per_month',
    'maintenance_hours_per_month',
    'admin_hours_per_month',
    'buffer_hours_per_month',
    'capacity_hours_per_month',
  ] as const) {
    const value = parameters[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${key} cannot be negative: ${String(value)}`);
    }
  }
  if (parameters.minimum_benefit_cost_ratio <= 0) {
    throw new RangeError(
      `minimum_benefit_cost_ratio must be greater than zero: ${parameters.minimum_benefit_cost_ratio}`,
    );
  }
  return parameters;
}
