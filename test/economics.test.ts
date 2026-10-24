import { describe, expect, it } from 'vitest';
import {
  capacityUtilization,
  computeScenario,
  economicRemainder,
  firstYearAverageCost,
  founderValueOf,
  scenarioCashCost,
  scenarioRevenue,
  targetBenefitOfCustomer,
  undefinedBecause,
} from '../src/domain/economics.js';
import type { BusinessModelParameters } from '../src/domain/parameters.js';

/**
 * The starting parameters from §10, which the spec labels as initial assumptions
 * rather than market-confirmed values.
 */
const STARTING_PARAMETERS: BusinessModelParameters = {
  pilot_fee_vnd: 3_000_000,
  setup_fee_vnd: 10_000_000,
  monthly_fee_vnd: 3_000_000,
  direct_cost_per_customer_month_vnd: 350_000,
  direct_cost_per_setup_vnd: 500_000,
  fixed_cost_per_month_vnd: 2_500_000,
  founder_hourly_value_vnd: 150_000,
  support_hours_per_customer_month: 4,
  setup_hours_per_customer: 24,
  sales_hours_per_month: 30,
  maintenance_hours_per_month: 12,
  admin_hours_per_month: 10,
  buffer_hours_per_month: 20,
  capacity_hours_per_month: 160,
  minimum_benefit_cost_ratio: 3,
};

describe('the three verification rows from §13', () => {
  it('reproduces N=5, S=0', () => {
    const r = computeScenario(STARTING_PARAMETERS, 5, 0);
    expect(r.revenue_vnd).toBe(15_000_000);
    expect(r.cash_cost_vnd).toBe(4_250_000);
    expect(r.cash_surplus_vnd).toBe(10_750_000);
    expect(r.hours).toBe(92);
    expect(r.founder_value_vnd).toBe(13_800_000);
    expect(r.economic_remainder_vnd).toBe(-3_050_000);
  });

  it('reproduces N=10, S=0', () => {
    const r = computeScenario(STARTING_PARAMETERS, 10, 0);
    expect(r.revenue_vnd).toBe(30_000_000);
    expect(r.cash_cost_vnd).toBe(6_000_000);
    expect(r.cash_surplus_vnd).toBe(24_000_000);
    expect(r.hours).toBe(112);
    expect(r.founder_value_vnd).toBe(16_800_000);
    expect(r.economic_remainder_vnd).toBe(7_200_000);
  });

  it('reproduces N=10, S=2, where capacity is exactly saturated', () => {
    const r = computeScenario(STARTING_PARAMETERS, 10, 2);
    expect(r.revenue_vnd).toBe(50_000_000);
    expect(r.cash_cost_vnd).toBe(7_000_000);
    expect(r.cash_surplus_vnd).toBe(43_000_000);
    expect(r.hours).toBe(160);
    expect(r.founder_value_vnd).toBe(24_000_000);
    expect(r.economic_remainder_vnd).toBe(19_000_000);
    expect(r.capacity_utilization).toEqual({ kind: 'value', value: 1 });
  });
});

describe('the individual §13 formulas', () => {
  it('counts revenue as N subscriptions plus S setups', () => {
    expect(scenarioRevenue(STARTING_PARAMETERS, 5, 0)).toBe(15_000_000);
    expect(scenarioRevenue(STARTING_PARAMETERS, 10, 2)).toBe(50_000_000);
  });

  it('counts cash cost as per-customer, per-setup and fixed cost', () => {
    expect(scenarioCashCost(STARTING_PARAMETERS, 5, 0)).toBe(4_250_000);
    expect(scenarioCashCost(STARTING_PARAMETERS, 10, 2)).toBe(7_000_000);
  });

  it('values founder hours at the configured hourly value', () => {
    expect(founderValueOf(STARTING_PARAMETERS, 92)).toBe(13_800_000);
  });

  it('subtracts founder value from the cash surplus to get the remainder', () => {
    expect(economicRemainder(10_750_000, 13_800_000)).toBe(-3_050_000);
  });

  it('computes the first-year average cost, which is not an integer', () => {
    // 10,000,000 / 12 is 833,333.33, so this is 3,833,333.33 exactly
    expect(firstYearAverageCost(STARTING_PARAMETERS)).toBe(3_833_333);
  });

  it('clears the fraction when multiplying by the benefit ratio', () => {
    // 3,833,333.33 × 3 = 11,500,000 exactly
    expect(targetBenefitOfCustomer(STARTING_PARAMETERS)).toBe(11_500_000);
  });

  it('reports capacity utilization as a fraction', () => {
    expect(capacityUtilization(STARTING_PARAMETERS, 160)).toEqual({
      kind: 'value',
      value: 1,
    });
    expect(capacityUtilization(STARTING_PARAMETERS, 92)).toEqual({
      kind: 'value',
      value: 0.575,
    });
  });
});

describe('missing and indeterminate inputs', () => {
  it('reports undefined with a reason rather than a fabricated number', () => {
    const result = capacityUtilization(
      { ...STARTING_PARAMETERS, capacity_hours_per_month: 0 },
      92,
    );
    expect(result.kind).toBe('undefined');
    if (result.kind === 'undefined') {
      expect(result.reason).toMatch(/capacity/i);
    }
  });

  it('refuses a zero capacity as a division by zero instead of emitting Infinity', () => {
    const r = computeScenario(
      { ...STARTING_PARAMETERS, capacity_hours_per_month: 0 },
      5,
      0,
    );
    expect(r.capacity_utilization.kind).toBe('undefined');
  });

  it('refuses a negative customer count', () => {
    expect(() => computeScenario(STARTING_PARAMETERS, -1, 0)).toThrow(
      /negative/i,
    );
  });

  it('refuses a negative setup count', () => {
    expect(() => computeScenario(STARTING_PARAMETERS, 5, -1)).toThrow(
      /negative/i,
    );
  });

  it('treats zero customers and zero setups as a real answer, not a missing one', () => {
    const r = computeScenario(STARTING_PARAMETERS, 0, 0);
    expect(r.revenue_vnd).toBe(0);
    expect(r.cash_cost_vnd).toBe(2_500_000);
    expect(r.economic_remainder_vnd).toBe(-13_300_000);
    expect(r.hours).toBe(72);
  });
});

describe('undefinedBecause', () => {
  it('carries a reason for every undefined result', () => {
    const u = undefinedBecause('capacity_hours_per_month is zero');
    expect(u.kind).toBe('undefined');
    if (u.kind === 'undefined') {
      expect(u.reason).toMatch(/capacity_hours_per_month is zero/);
    }
  });
});
