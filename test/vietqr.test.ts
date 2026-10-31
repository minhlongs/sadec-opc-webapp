import { describe, expect, it } from 'vitest';
import {
  buildVietQrEscrowPayload,
  crc16Ccitt,
  escrowAccountFrom,
  tryBuildVietQrEscrowPayload,
} from '../src/domain/vietqr.ts';

/** A configured account, standing in for deployment configuration. */
const ACCOUNT = { bankBin: '970415', accountNumber: '0011002233445', accountHolder: 'CONG TY THU NGHIEM' };

describe('crc16Ccitt', () => {
  it('computes standard CRC-16/CCITT-FALSE checksum for ASCII 123456789', () => {
    // Standard test vector for CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF): 0x29B1
    expect(crc16Ccitt('123456789')).toBe('29B1');
  });
});

describe('buildVietQrEscrowPayload', () => {
  it('generates valid dynamic VietQR EMVCo string for Deposit (DEP)', () => {
    const qr = buildVietQrEscrowPayload({
      ...ACCOUNT,
      amountVnd: 4000000,
      bookingCode: 'SDEC-BK-1001',
      phase: 'DEP',
    });

    expect(qr.transferNote).toBe('SDEC DEP SDEC-BK-1001');
    expect(qr.amountVnd).toBe(4000000);
    expect(qr.emvPayload).toContain('000201010212');
    expect(qr.emvPayload).toContain('5303704');
    expect(qr.emvPayload).toContain('54074000000');
    expect(qr.emvPayload).toContain('5802VN');
    expect(qr.emvPayload).toContain('SDEC DEP SDEC-BK-1001');
    expect(qr.emvPayload.endsWith(qr.crc16)).toBe(true);
    expect(qr.crc16).toHaveLength(4);
  });

  it('generates valid dynamic VietQR EMVCo string for Balance (BAL)', () => {
    const qr = buildVietQrEscrowPayload({
      ...ACCOUNT,
      amountVnd: 6300000,
      bookingCode: 'SDEC-BK-1001',
      phase: 'BAL',
    });

    expect(qr.transferNote).toBe('SDEC BAL SDEC-BK-1001');
    expect(qr.emvPayload).toContain('SDEC BAL SDEC-BK-1001');
  });

  it('rejects non-positive or fractional VND amounts', () => {
    expect(() =>
      buildVietQrEscrowPayload({
        ...ACCOUNT,
        amountVnd: 0,
        bookingCode: 'SDEC-BK-1001',
        phase: 'DEP',
      }),
    ).toThrow(RangeError);
  });

  it('refuses to build a payload without a configured account', () => {
    expect(() =>
      buildVietQrEscrowPayload({
        bankBin: '',
        accountNumber: '',
        accountHolder: '',
        amountVnd: 1000,
        bookingCode: 'SDEC-BK-1',
        phase: 'DEP',
      }),
    ).toThrow(/bank BIN and account number/);
  });

  it('returns null rather than a QR when no account is configured', () => {
    expect(tryBuildVietQrEscrowPayload(null, { amountVnd: 1000, bookingCode: 'SDEC-BK-1', phase: 'DEP' })).toBeNull();
    expect(
      tryBuildVietQrEscrowPayload(ACCOUNT, { amountVnd: 1000, bookingCode: 'SDEC-BK-1', phase: 'DEP' })?.accountNumber,
    ).toBe(ACCOUNT.accountNumber);
  });

  it('reads the account from configuration only when all three parts are plausible', () => {
    expect(escrowAccountFrom({})).toBeNull();
    // The old built-in placeholder must never come back through a default.
    expect(escrowAccountFrom({ ESCROW_ACCOUNT_NUMBER: '113002899999' })).toBeNull();
    expect(
      escrowAccountFrom({
        ESCROW_BANK_BIN: '970415',
        ESCROW_ACCOUNT_NUMBER: '0011002233445',
        ESCROW_ACCOUNT_HOLDER: 'CONG TY THU NGHIEM',
      }),
    ).toEqual(ACCOUNT);
    expect(
      escrowAccountFrom({
        ESCROW_BANK_BIN: 'not-a-bin',
        ESCROW_ACCOUNT_NUMBER: '0011002233445',
        ESCROW_ACCOUNT_HOLDER: 'CONG TY THU NGHIEM',
      }),
    ).toBeNull();
  });
});
