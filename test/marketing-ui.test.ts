import { describe, expect, it } from 'vitest';
import { computeMiddlemanSavingsComparison } from '../src/ui/components/marketing-landing.tsx';
import {
  OBJECTION_HANDLERS,
  SEO_AEO_KEYWORDS,
  SHORT_VIDEO_SCRIPTS,
  ZALO_TEMPLATES,
} from '../src/ui/components/marketing-gtm-hub.tsx';

describe('Marketing UI/UX Suite — ROI Calculator & CMO GTM Hub Data', () => {
  it('computeMiddlemanSavingsComparison computes exact integer VND savings and 0 VND platform outlay', () => {
    // 50 units * 300,000 VND = 15,000,000 VND gross
    // Deposit 40% (4000 bps) = 6,000,000 VND
    // Platform fee 3% (300 bps) = 450,000 VND
    // Buyer total on Sa Đéc Flow = 15,450,000 VND
    // Middleman markup 25% (2500 bps) = 3,750,000 VND -> Middleman total = 18,750,000 VND
    // Net savings = 18,750,000 - 15,450,000 = 3,300,000 VND
    const result = computeMiddlemanSavingsComparison({
      quantity: 50,
      unitPriceVnd: 300000,
      depositRateBps: 4000,
      platformFeeBps: 300,
      middlemanMarkupBps: 2500,
    });

    expect(result.platformOutlayVnd).toBe(0);
    expect(result.quote.grossTotalVnd).toBe(15000000);
    expect(result.quote.depositRequiredVnd).toBe(6000000);
    expect(result.quote.platformFeeVnd).toBe(450000);
    expect(result.quote.estimatedBuyerTotalVnd).toBe(15450000);
    expect(result.middlemanMarkupVnd).toBe(3750000);
    expect(result.middlemanTotalVnd).toBe(18750000);
    expect(result.netSavingsVnd).toBe(3300000);
    expect(Number.isInteger(result.netSavingsVnd)).toBe(true);
  });

  it('CMO & GTM Hub exports all 4 Zalo VietQR templates, 10 Objection handlers, 15 Short Video scripts, and 30 SEO/AEO keywords', () => {
    expect(ZALO_TEMPLATES).toHaveLength(4);
    expect(JSON.stringify(ZALO_TEMPLATES)).toContain('SAN GIAO DICH HOA KIENG SA DEC ESCROW');

    expect(OBJECTION_HANDLERS).toHaveLength(10);
    const nurseryObjections = OBJECTION_HANDLERS.filter((o) => o.persona === 'NURSERY');
    const shopObjections = OBJECTION_HANDLERS.filter((o) => o.persona === 'SHOP');
    expect(nurseryObjections).toHaveLength(5);
    expect(shopObjections).toHaveLength(5);

    expect(SHORT_VIDEO_SCRIPTS).toHaveLength(15);
    expect(SEO_AEO_KEYWORDS).toHaveLength(30);
  });
});
