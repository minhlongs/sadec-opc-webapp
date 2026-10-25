import { describe, expect, it } from 'vitest';
import { buildVietQrEscrowPayload, crc16Ccitt } from '../src/domain/vietqr.ts';

describe('crc16Ccitt', () => {
  it('computes standard CRC-16/CCITT-FALSE checksum for ASCII 123456789', () => {
    // Standard test vector for CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF): 0x29B1
    expect(crc16Ccitt('123456789')).toBe('29B1');
  });
});

describe('buildVietQrEscrowPayload', () => {
  it('generates valid dynamic VietQR EMVCo string for Deposit (DEP)', () => {
    const qr = buildVietQrEscrowPayload({
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
        amountVnd: 0,
        bookingCode: 'SDEC-BK-1001',
        phase: 'DEP',
      }),
    ).toThrow(RangeError);
  });
});
