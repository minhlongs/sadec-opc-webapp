/**
 * 3-6 Month Pilot KPI Metrics calculation for Founders.
 *
 * Tracks:
 *  1. Verified Sa Đéc Nurseries (Goal: 20–30)
 *  2. Active TP.HCM Buyer Shops (Goal: 30–50)
 *  3. Completed B2B Bookings / month (Goal: ~100)
 *  4. Month-2 Re-order Retention Rate in Basis Points (Goal: > 4,000 bps / 40%)
 *  5. Invariant Balance Check: Discrepant bookings === 0, Platform Outlay === 0 VND
 */

export interface PilotMetricsInput {
  verifiedNurseriesCount: number;
  activeBuyerShopsCount: number;
  completedBookingsCount: number;
  repeatBuyersCount: number;
  totalUniqueBuyersEligibleForRetention: number;
  unbalancedSettledBookingsCount: number;
  totalPlatformOutlayVnd: number;
}

export interface PilotMetricsResult {
  verifiedNurseriesCount: number;
  activeBuyerShopsCount: number;
  completedBookingsCount: number;
  retentionRateBps: number;
  isNurseryGoalMet: boolean;
  isBuyerGoalMet: boolean;
  isOrderVolumeGoalMet: boolean;
  isRetentionGoalMet: boolean;
  unbalancedSettledBookingsCount: number;
  totalPlatformOutlayVnd: number;
  isLedgerBalanced: boolean;
}

export function computePilotMetrics({
  verifiedNurseriesCount,
  activeBuyerShopsCount,
  completedBookingsCount,
  repeatBuyersCount,
  totalUniqueBuyersEligibleForRetention,
  unbalancedSettledBookingsCount,
  totalPlatformOutlayVnd,
}: PilotMetricsInput): PilotMetricsResult {
  let retentionRateBps = 0;
  if (totalUniqueBuyersEligibleForRetention > 0) {
    retentionRateBps = Math.trunc(
      (repeatBuyersCount * 10_000) / totalUniqueBuyersEligibleForRetention,
    );
  }

  return {
    verifiedNurseriesCount,
    activeBuyerShopsCount,
    completedBookingsCount,
    retentionRateBps,
    isNurseryGoalMet: verifiedNurseriesCount >= 20,
    isBuyerGoalMet: activeBuyerShopsCount >= 30,
    isOrderVolumeGoalMet: completedBookingsCount >= 100,
    isRetentionGoalMet: retentionRateBps >= 4000,
    unbalancedSettledBookingsCount,
    totalPlatformOutlayVnd,
    isLedgerBalanced: unbalancedSettledBookingsCount === 0 && totalPlatformOutlayVnd === 0,
  };
}
