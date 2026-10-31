import { describe, expect, it } from 'vitest';
import {
  calculateBookingQuote,
  calculateInspectionSettlement,
  assertZeroPlatformOutlay,
} from '../src/domain/escrow-ledger.ts';
import { signLotQrToken, verifyLotQrToken } from '../src/domain/lot-qr.ts';
import { buildVietQrEscrowPayload } from '../src/domain/vietqr.ts';

/** A configured escrow account, standing in for deployment configuration. */
const ESCROW = { bankBin: '970415', accountNumber: '0011002233445', accountHolder: 'CONG TY THU NGHIEM' };

describe('B2B Floriculture Grab-Platform End-to-End Workflow', () => {
  const SECRET = 'sadec-hub-hmac-sha256-key';

  it('Scenario 1: Full Lifecycle with 100% Accepted Quality', async () => {
    // 1. Nursery posts lot: 50 pots @ 200,000 VND
    const lotId = 'lot-test-s1';
    const qrToken = await signLotQrToken(
      { kind: 'LOT', entityId: lotId, workspaceId: 'ws-demo-a', issuedAt: new Date().toISOString() },
      SECRET,
    );
    expect(await verifyLotQrToken(qrToken, SECRET)).not.toBeNull();

    // 2. Buyer Shop in HCM books 50 pots with 40% deposit & 3% platform fee
    const quote = calculateBookingQuote({
      quantity: 50,
      unitPriceVnd: 200000,
      depositRateBps: 4000,
      platformFeeBps: 300,
    });
    expect(quote.grossTotalVnd).toBe(10000000);
    expect(quote.depositRequiredVnd).toBe(4000000);
    expect(quote.platformFeeVnd).toBe(300000);

    // 3. Deposit VietQR generated
    const depQr = buildVietQrEscrowPayload({
      ...ESCROW,
      amountVnd: quote.depositRequiredVnd,
      bookingCode: 'SDEC-BK-S1',
      phase: 'DEP',
    });
    expect(depQr.transferNote).toBe('SDEC DEP SDEC-BK-S1');
    expect(depQr.amountVnd).toBe(4000000);

    // 4. Hub Sa Đéc verifies package and signs HMAC-SHA256 QR
    const pkgId = 'pkg-test-s1';
    const pkgQr = await signLotQrToken(
      { kind: 'PKG', entityId: pkgId, workspaceId: 'ws-demo-a', issuedAt: new Date().toISOString() },
      SECRET,
    );
    const verifiedPkg = await verifyLotQrToken(pkgQr, SECRET);
    expect(verifiedPkg?.kind).toBe('PKG');

    // 5. Shop HCM inspects: 100% Accepted (50/50 units)
    const settlement = calculateInspectionSettlement({
      unitPriceVnd: 200000,
      grossTotalVnd: quote.grossTotalVnd,
      depositPaidVnd: 4000000,
      platformFeeBps: 300,
      totalUnits: 50,
      acceptedUnits: 50,
      defectiveUnits: 0,
      faultParty: 'NONE',
    });

    // Invariant assertions
    assertZeroPlatformOutlay(settlement);
    expect(settlement.platformOutlayVnd).toBe(0);
    expect(settlement.acceptedValueVnd).toBe(10000000);
    expect(settlement.nurseryPayoutVnd).toBe(10000000);
    expect(settlement.platformFeeRetainedVnd).toBe(300000);
    expect(settlement.buyerBalanceRequiredVnd).toBe(6300000);
    expect(settlement.buyerRefundVnd).toBe(0);

    // 6. Balance VietQR generated
    const balQr = buildVietQrEscrowPayload({
      ...ESCROW,
      amountVnd: settlement.buyerBalanceRequiredVnd,
      bookingCode: 'SDEC-BK-S1',
      phase: 'BAL',
    });
    expect(balQr.transferNote).toBe('SDEC BAL SDEC-BK-S1');
    expect(balQr.amountVnd).toBe(6300000);
  });

  it('Scenario 2: Partial Defect (20% defect due to Nursery Fault)', () => {
    // 50 pots @ 200,000 VND = 10,000,000 VND
    // 10 defective units due to nursery fault, 40 accepted units (8,000,000 VND)
    // Deposit already paid: 4,000,000 VND
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

    assertZeroPlatformOutlay(settlement);
    expect(settlement.platformOutlayVnd).toBe(0);
    expect(settlement.acceptedValueVnd).toBe(8000000);
    expect(settlement.nurseryDeductionVnd).toBe(2000000);
    expect(settlement.nurseryPayoutVnd).toBe(8000000);
    expect(settlement.platformFeeRetainedVnd).toBe(240000); // 3% on 8M
    expect(settlement.buyerBalanceRequiredVnd).toBe(4240000); // 8M + 240k - 4M deposit
    expect(settlement.buyerRefundVnd).toBe(0);
  });

  it('Scenario 3: 100% Rejection due to Nursery Fault (Full Refund)', () => {
    // 0/50 accepted, 50 defective due to nursery fault
    // Full refund of 4,000,000 VND deposit to buyer shop
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

    assertZeroPlatformOutlay(settlement);
    expect(settlement.platformOutlayVnd).toBe(0);
    expect(settlement.acceptedValueVnd).toBe(0);
    expect(settlement.nurseryDeductionVnd).toBe(10000000);
    expect(settlement.nurseryPayoutVnd).toBe(0);
    expect(settlement.platformFeeRetainedVnd).toBe(0);
    expect(settlement.buyerBalanceRequiredVnd).toBe(0);
    expect(settlement.buyerRefundVnd).toBe(4000000);
  });

  it('Scenario 4: Seasonal Tet Pre-order with 30% Deposit and 4% Platform Fee', () => {
    const quote = calculateBookingQuote({
      quantity: 120,
      unitPriceVnd: 150000,
      depositRateBps: 3000,
      platformFeeBps: 400,
    });
    expect(quote.grossTotalVnd).toBe(18000000);
    expect(quote.depositRequiredVnd).toBe(5400000);
    expect(quote.platformFeeVnd).toBe(720000);
    expect(quote.estimatedBuyerTotalVnd).toBe(18720000);
  });

  it('Scenario 5: Severe Defect Exceeding Non-Deposit Portion Triggers Partial Deposit Refund', () => {
    // 50 pots @ 200k = 10M. Deposit 40% = 4M.
    // Only 10 accepted (2M accepted value). Fee 3% of 2M = 60k. Total owed by buyer = 2.06M.
    // Buyer already paid 4M deposit -> Buyer gets 1.94M refund!
    const settlement = calculateInspectionSettlement({
      unitPriceVnd: 200000,
      grossTotalVnd: 10000000,
      depositPaidVnd: 4000000,
      platformFeeBps: 300,
      totalUnits: 50,
      acceptedUnits: 10,
      defectiveUnits: 40,
      faultParty: 'NURSERY',
    });

    assertZeroPlatformOutlay(settlement);
    expect(settlement.acceptedValueVnd).toBe(2000000);
    expect(settlement.platformFeeRetainedVnd).toBe(60000);
    expect(settlement.buyerBalanceRequiredVnd).toBe(0);
    expect(settlement.buyerRefundVnd).toBe(1940000);
    expect(settlement.nurseryPayoutVnd).toBe(2000000);
  });

  it('Scenario 6: Carrier Fault Still Enforces Zero Platform Outlay', () => {
    const settlement = calculateInspectionSettlement({
      unitPriceVnd: 100000,
      grossTotalVnd: 5000000,
      depositPaidVnd: 1500000,
      platformFeeBps: 300,
      totalUnits: 50,
      acceptedUnits: 45,
      defectiveUnits: 5,
      faultParty: 'CARRIER',
    });

    assertZeroPlatformOutlay(settlement);
    expect(settlement.platformOutlayVnd).toBe(0);
    expect(settlement.acceptedValueVnd).toBe(4500000);
  });

  it('Scenario 7: Rejects Tampered QR Token at Checkpoint 2', async () => {
    const validToken = await signLotQrToken(
      { kind: 'PKG', entityId: 'pkg-999', workspaceId: 'ws-demo-a', issuedAt: new Date().toISOString() },
      SECRET,
    );
    const tampered = validToken.slice(0, -3) + 'xyz';
    expect(await verifyLotQrToken(tampered, SECRET)).toBeNull();
  });

  it('Scenario 8: Rejects Wrong Secret Key on QR Verification', async () => {
    const validToken = await signLotQrToken(
      { kind: 'LOT', entityId: 'lot-999', workspaceId: 'ws-demo-a', issuedAt: new Date().toISOString() },
      SECRET,
    );
    expect(await verifyLotQrToken(validToken, 'wrong-secret-key')).toBeNull();
  });

  it('Scenario 9: VietQR Payload Includes Deterministic CRC16-CCITT Checksum', () => {
    const p1 = buildVietQrEscrowPayload({
      ...ESCROW,
      amountVnd: 3500000,
      bookingCode: 'SDEC-2026-8888',
      phase: 'DEP',
    });
    const p2 = buildVietQrEscrowPayload({
      ...ESCROW,
      amountVnd: 3500000,
      bookingCode: 'SDEC-2026-8888',
      phase: 'DEP',
    });
    expect(p1.emvPayload).toBe(p2.emvPayload);
    expect(p1.crc16).toHaveLength(4);
    expect(p1.emvPayload.endsWith(p1.crc16)).toBe(true);
  });

  it('Scenario 10: Rejects Unit Mismatch During Inspection Settlement', () => {
    expect(() =>
      calculateInspectionSettlement({
        unitPriceVnd: 100000,
        grossTotalVnd: 5000000,
        depositPaidVnd: 1500000,
        platformFeeBps: 300,
        totalUnits: 50,
        acceptedUnits: 30,
        defectiveUnits: 10, // 30 + 10 != 50
        faultParty: 'NURSERY',
      }),
    ).toThrow(/Accepted .* defective .* must equal/);
  });

  it('Scenario 11: Rejects Platform Fee Rate Outside 2-5% Bounds', () => {
    expect(() =>
      calculateBookingQuote({
        quantity: 20,
        unitPriceVnd: 100000,
        depositRateBps: 3000,
        platformFeeBps: 150, // 1.5% < 2%
      }),
    ).toThrow(/Platform fee rate must be between 200/);
  });
});
