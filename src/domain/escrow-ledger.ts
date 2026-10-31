/**
 * Escrow Ledger calculations for B2B Floriculture Pre-order Platform.
 *
 * All amounts are integer VND (via src/domain/money.ts).
 * Invariant: Platform Working Capital Outlay is ALWAYS 0 VND.
 * platformOutlayVnd === 0
 * buyerTotalObligationVnd === nurseryPayoutVnd + buyerRefundVnd + platformFeeRetainedVnd
 *
 * What these numbers are, and are not
 *
 * `calculateInspectionSettlement` computes *obligations*: what the buyer still
 * owes (`buyerBalanceRequiredVnd`), what is payable to the nursery
 * (`nurseryPayoutVnd`), what is refundable (`buyerRefundVnd`) and what the
 * platform may retain (`platformFeeRetainedVnd`). The only cash fact it is
 * given is `depositPaidVnd`, the deposit a founder already confirmed.
 * `buyerTotalObligationVnd` is the deposit plus the balance *if* that balance
 * is received — a projection, not a receipt. Whether money actually arrived is
 * recorded elsewhere (the escrow ledger, by a person with a reference), never
 * inferred from this calculation.
 */

import { assertSafeVnd, multiplyByBasisPoints } from './money.ts';

export type InspectionFaultParty = 'NONE' | 'NURSERY' | 'CARRIER';

export interface BookingQuoteInput {
  quantity: number;
  unitPriceVnd: number;
  depositRateBps: number;
  platformFeeBps: number;
}

export interface BookingQuoteResult {
  grossTotalVnd: number;
  depositRequiredVnd: number;
  platformFeeVnd: number;
  estimatedBuyerTotalVnd: number;
}

export interface InspectionSettlementInput {
  unitPriceVnd: number;
  grossTotalVnd: number;
  depositPaidVnd: number;
  platformFeeBps: number;
  totalUnits: number;
  acceptedUnits: number;
  defectiveUnits: number;
  faultParty: InspectionFaultParty;
}

export interface InspectionSettlementResult {
  acceptedUnits: number;
  defectiveUnits: number;
  faultParty: InspectionFaultParty;
  acceptedValueVnd: number;
  nurseryDeductionVnd: number;
  platformFeeRetainedVnd: number;
  buyerBalanceRequiredVnd: number;
  buyerRefundVnd: number;
  nurseryPayoutVnd: number;
  platformOutlayVnd: number;
  /**
   * Deposit already confirmed plus the balance still owed. This is the total
   * the buyer is obliged to have paid once settlement completes — an
   * obligation, not evidence that the balance was received.
   */
  buyerTotalObligationVnd: number;
}

/**
 * Calculates pre-order booking deposit and platform fee breakdown.
 */
export function calculateBookingQuote({
  quantity,
  unitPriceVnd,
  depositRateBps,
  platformFeeBps,
}: BookingQuoteInput): BookingQuoteResult {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`Quantity must be a positive integer: ${quantity}`);
  }
  assertSafeVnd(unitPriceVnd);
  if (unitPriceVnd <= 0) {
    throw new RangeError(`Unit price must be positive integer VND: ${unitPriceVnd}`);
  }
  if (!Number.isInteger(depositRateBps) || depositRateBps < 3000 || depositRateBps > 5000) {
    throw new RangeError(`Deposit rate must be between 3000 and 5000 bps (30%-50%): ${depositRateBps}`);
  }
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 200 || platformFeeBps > 500) {
    throw new RangeError(`Platform fee rate must be between 200 and 500 bps (2%-5%): ${platformFeeBps}`);
  }

  const grossTotalVnd = assertSafeVnd(quantity * unitPriceVnd);
  const depositRequiredVnd = multiplyByBasisPoints(grossTotalVnd, depositRateBps);
  const platformFeeVnd = multiplyByBasisPoints(grossTotalVnd, platformFeeBps);
  const estimatedBuyerTotalVnd = assertSafeVnd(grossTotalVnd + platformFeeVnd);

  return {
    grossTotalVnd,
    depositRequiredVnd,
    platformFeeVnd,
    estimatedBuyerTotalVnd,
  };
}

/**
 * Calculates final inspection settlement and asserts 0 VND platform outlay invariant.
 */
export function calculateInspectionSettlement({
  unitPriceVnd,
  grossTotalVnd,
  depositPaidVnd,
  platformFeeBps,
  totalUnits,
  acceptedUnits,
  defectiveUnits,
  faultParty,
}: InspectionSettlementInput): InspectionSettlementResult {
  assertSafeVnd(unitPriceVnd);
  assertSafeVnd(grossTotalVnd);
  assertSafeVnd(depositPaidVnd);

  if (unitPriceVnd <= 0) {
    throw new RangeError(`Unit price must be positive: ${unitPriceVnd}`);
  }
  if (!Number.isInteger(totalUnits) || totalUnits <= 0) {
    throw new RangeError(`Total units must be positive integer: ${totalUnits}`);
  }
  if (!Number.isInteger(acceptedUnits) || acceptedUnits < 0) {
    throw new RangeError(`Accepted units cannot be negative: ${acceptedUnits}`);
  }
  if (!Number.isInteger(defectiveUnits) || defectiveUnits < 0) {
    throw new RangeError(`Defective units cannot be negative: ${defectiveUnits}`);
  }
  if (acceptedUnits + defectiveUnits !== totalUnits) {
    throw new RangeError(
      `Accepted (${acceptedUnits}) + defective (${defectiveUnits}) must equal total units (${totalUnits})`,
    );
  }
  if (totalUnits * unitPriceVnd !== grossTotalVnd) {
    throw new RangeError(
      `Total units (${totalUnits}) * unit price (${unitPriceVnd}) must equal gross total (${grossTotalVnd})`,
    );
  }
  if (defectiveUnits > 0 && faultParty === 'NONE') {
    throw new RangeError('Fault party must be specified when defective units exist.');
  }

  // Scenario 3: 100% rejection due to nursery fault
  if (faultParty === 'NURSERY' && acceptedUnits === 0) {
    const result: InspectionSettlementResult = {
      acceptedUnits: 0,
      defectiveUnits: totalUnits,
      faultParty,
      acceptedValueVnd: 0,
      nurseryDeductionVnd: grossTotalVnd,
      platformFeeRetainedVnd: 0,
      buyerBalanceRequiredVnd: 0,
      buyerRefundVnd: depositPaidVnd,
      nurseryPayoutVnd: 0,
      platformOutlayVnd: 0,
      buyerTotalObligationVnd: depositPaidVnd,
    };
    assertZeroPlatformOutlay(result);
    return result;
  }

  // Value of delivered units that passed inspection
  const acceptedValueVnd = assertSafeVnd(acceptedUnits * unitPriceVnd);
  const nurseryDeductionVnd = assertSafeVnd(defectiveUnits * unitPriceVnd);

  // Platform fee is assessed on the accepted value delivered
  const platformFeeRetainedVnd = multiplyByBasisPoints(acceptedValueVnd, platformFeeBps);
  const finalBuyerObligationVnd = assertSafeVnd(acceptedValueVnd + platformFeeRetainedVnd);

  let buyerBalanceRequiredVnd = 0;
  let buyerRefundVnd = 0;

  if (depositPaidVnd < finalBuyerObligationVnd) {
    buyerBalanceRequiredVnd = assertSafeVnd(finalBuyerObligationVnd - depositPaidVnd);
  } else {
    buyerRefundVnd = assertSafeVnd(depositPaidVnd - finalBuyerObligationVnd);
  }

  // Nursery receives exact value of accepted items
  const nurseryPayoutVnd = acceptedValueVnd;
  const buyerTotalObligationVnd = assertSafeVnd(depositPaidVnd + buyerBalanceRequiredVnd);
  const platformOutlayVnd = 0;

  const result: InspectionSettlementResult = {
    acceptedUnits,
    defectiveUnits,
    faultParty,
    acceptedValueVnd,
    nurseryDeductionVnd,
    platformFeeRetainedVnd,
    buyerBalanceRequiredVnd,
    buyerRefundVnd,
    nurseryPayoutVnd,
    platformOutlayVnd,
    buyerTotalObligationVnd,
  };

  assertZeroPlatformOutlay(result);
  return result;
}

/**
 * Asserts strict mathematical balance:
 * 1. Platform advances zero capital: platformOutlayVnd === 0
 * 2. Obligations balance: buyerTotalObligationVnd === nurseryPayoutVnd + buyerRefundVnd + platformFeeRetainedVnd
 *    (an identity over computed obligations; it says nothing about cash received)
 */
export function assertZeroPlatformOutlay(settlement: InspectionSettlementResult): void {
  if (settlement.platformOutlayVnd !== 0) {
    throw new Error(
      `Ledger Invariant Violation: Platform outlay must be 0 VND, found ${settlement.platformOutlayVnd}`,
    );
  }

  const totalDisbursedOrRetained = assertSafeVnd(
    settlement.nurseryPayoutVnd + settlement.buyerRefundVnd + settlement.platformFeeRetainedVnd,
  );

  if (settlement.buyerTotalObligationVnd !== totalDisbursedOrRetained) {
    throw new Error(
      `Ledger Invariant Violation: buyer obligation (${settlement.buyerTotalObligationVnd} VND) != payout + refund + fee (${totalDisbursedOrRetained} VND)`,
    );
  }
}
