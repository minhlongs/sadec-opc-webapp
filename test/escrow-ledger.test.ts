import { describe, expect, it } from 'vitest';
import {
  calculateBookingQuote,
  calculateInspectionSettlement,
  assertZeroPlatformOutlay,
} from '../src/domain/escrow-ledger.ts';

describe('calculateBookingQuote', () => {
  it('computes 40% deposit and 3% platform fee in integer VND', () => {
    // 50 pots @ 200,000 VND = 10,000,000 VND
    const quote = calculateBookingQuote({
      quantity: 50,
      unitPriceVnd: 200000,
      depositRateBps: 4000,
      platformFeeBps: 300,
    });

    expect(quote.grossTotalVnd).toBe(10000000);
    expect(quote.depositRequiredVnd).toBe(4000000);
    expect(quote.platformFeeVnd).toBe(300000);
    expect(quote.estimatedBuyerTotalVnd).toBe(10300000);
  });

  it('rejects deposit rate outside 3000..5000 bps', () => {
    expect(() =>
      calculateBookingQuote({
        quantity: 10,
        unitPriceVnd: 100000,
        depositRateBps: 2500,
        platformFeeBps: 300,
      }),
    ).toThrow(RangeError);
  });
});

describe('calculateInspectionSettlement - 3 Core Scenarios', () => {
  it('Scenario 1: 100% Accepted - Zero platform outlay', () => {
    // 50 units @ 200,000 VND = 10,000,000 VND
    // Paid 4,000,000 VND deposit. Platform fee = 300,000 VND (3%).
    const settlement = calculateInspectionSettlement({
      unitPriceVnd: 200000,
      grossTotalVnd: 10000000,
      depositPaidVnd: 4000000,
      platformFeeBps: 300,
      totalUnits: 50,
      acceptedUnits: 50,
      defectiveUnits: 0,
      faultParty: 'NONE',
    });

    expect(settlement.acceptedValueVnd).toBe(10000000);
    expect(settlement.nurseryDeductionVnd).toBe(0);
    expect(settlement.platformFeeRetainedVnd).toBe(300000);
    expect(settlement.buyerBalanceRequiredVnd).toBe(6300000);
    expect(settlement.buyerRefundVnd).toBe(0);
    expect(settlement.nurseryPayoutVnd).toBe(10000000);
    expect(settlement.platformOutlayVnd).toBe(0);
    expect(settlement.totalCollectedFromBuyerVnd).toBe(10300000);

    expect(() => assertZeroPlatformOutlay(settlement)).not.toThrow();
  });

  it('Scenario 2: Partial Defect 20% due to nursery fault', () => {
    // 10/50 defective due to nursery fault, 40/50 accepted.
    // Accepted value = 40 * 200,000 = 8,000,000 VND
    // Nursery deduction = 10 * 200,000 = 2,000,000 VND
    // Fee 3% on 8,000,000 = 240,000 VND
    // Total buyer obligation = 8,240,000 VND
    // Buyer already paid deposit 4,000,000 VND -> pays balance 4,240,000 VND.
    const settlement = calculateInspectionSettlement({
      unitPriceVnd: 200000,
      grossTotalVnd: 10000000,
      depositPaidVnd: 4000000,
      platformFeeBps: 300,
      totalUnits: 50,
      acceptedUnits: 40,
      defectiveUnits: 10,
      faultParty: 'NURSERY',
    });

    expect(settlement.acceptedValueVnd).toBe(8000000);
    expect(settlement.nurseryDeductionVnd).toBe(2000000);
    expect(settlement.platformFeeRetainedVnd).toBe(240000);
    expect(settlement.buyerBalanceRequiredVnd).toBe(4240000);
    expect(settlement.buyerRefundVnd).toBe(0);
    expect(settlement.nurseryPayoutVnd).toBe(8000000);
    expect(settlement.platformOutlayVnd).toBe(0);
    expect(settlement.totalCollectedFromBuyerVnd).toBe(8240000);

    expect(() => assertZeroPlatformOutlay(settlement)).not.toThrow();
  });

  it('Scenario 3: 100% Rejection due to nursery fault', () => {
    // 0/50 accepted, 50 defective due to nursery fault.
    // 100% refund of deposit 4,000,000 VND to buyer.
    // Nursery receives 0 VND. Platform fee 0 VND. Platform outlay 0 VND.
    const settlement = calculateInspectionSettlement({
      unitPriceVnd: 200000,
      grossTotalVnd: 10000000,
      depositPaidVnd: 4000000,
      platformFeeBps: 300,
      totalUnits: 50,
      acceptedUnits: 0,
      defectiveUnits: 50,
      faultParty: 'NURSERY',
    });

    expect(settlement.acceptedValueVnd).toBe(0);
    expect(settlement.nurseryDeductionVnd).toBe(10000000);
    expect(settlement.platformFeeRetainedVnd).toBe(0);
    expect(settlement.buyerBalanceRequiredVnd).toBe(0);
    expect(settlement.buyerRefundVnd).toBe(4000000);
    expect(settlement.nurseryPayoutVnd).toBe(0);
    expect(settlement.platformOutlayVnd).toBe(0);
    expect(settlement.totalCollectedFromBuyerVnd).toBe(4000000);

    expect(() => assertZeroPlatformOutlay(settlement)).not.toThrow();
  });

  it('enforces total units equals accepted + defective', () => {
    expect(() =>
      calculateInspectionSettlement({
        unitPriceVnd: 200000,
        grossTotalVnd: 10000000,
        depositPaidVnd: 4000000,
        platformFeeBps: 300,
        totalUnits: 50,
        acceptedUnits: 45,
        defectiveUnits: 10, // 45 + 10 != 50
        faultParty: 'NURSERY',
      }),
    ).toThrow(RangeError);
  });
});
