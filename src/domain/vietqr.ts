/**
 * Dynamic VietQR EMVCo ISO/IEC 18004 NAPAS 247 Generator for B2B Escrow Deposits & Settlement.
 *
 * Uses polynomial 0x1021, initial value 0xFFFF for CRC16-CCITT.
 */

import { assertSafeVnd } from './money.ts';

export type VietQrPhase = 'DEP' | 'BAL';

export interface VietQrPayloadInput {
  bankBin?: string;
  accountNumber?: string;
  accountHolder?: string;
  amountVnd: number;
  bookingCode: string;
  phase: VietQrPhase;
}

export interface VietQrPayloadResult {
  emvPayload: string;
  transferNote: string;
  amountVnd: number;
  bankBin: string;
  accountNumber: string;
  accountHolder: string;
  crc16: string;
}

const DEFAULT_BANK_BIN = '970415'; // VietinBank NAPAS BIN
const DEFAULT_ESCROW_ACCOUNT = '113002899999';
const DEFAULT_ACCOUNT_HOLDER = 'SAN GIAO DICH HOA KIENG SA DEC ESCROW';

function formatTlv(tag: string, value: string): string {
  const length = value.length.toString().padStart(2, '0');
  return `${tag}${length}${value}`;
}

/**
 * Computes CRC-16/CCITT-FALSE (polynomial 0x1021, initial 0xFFFF, no final XOR)
 * returned as 4 uppercase hex characters.
 */
export function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Builds a dynamic VietQR EMVCo string for either Deposit (`DEP`) or Balance (`BAL`).
 */
export function buildVietQrEscrowPayload({
  bankBin = DEFAULT_BANK_BIN,
  accountNumber = DEFAULT_ESCROW_ACCOUNT,
  accountHolder = DEFAULT_ACCOUNT_HOLDER,
  amountVnd,
  bookingCode,
  phase,
}: VietQrPayloadInput): VietQrPayloadResult {
  assertSafeVnd(amountVnd);
  if (amountVnd <= 0) {
    throw new RangeError(`VietQR amount must be positive integer VND: ${amountVnd}`);
  }
  const cleanCode = bookingCode.trim().replace(/[^A-Za-z0-9-]/g, '');
  if (cleanCode.length === 0) {
    throw new RangeError('Booking code is required for VietQR transfer note');
  }

  const transferNote = `SDEC ${phase} ${cleanCode}`;

  // Merchant Account Information (Tag 38 - NAPAS 247 QRIBFTTA)
  const guid = formatTlv('00', 'A000000727');
  const beneficiary = formatTlv('00', bankBin) + formatTlv('01', accountNumber);
  const consumerInfo = formatTlv('01', beneficiary) + formatTlv('02', 'QRIBFTTA');
  const merchantAccountInfo = formatTlv('38', guid + consumerInfo);

  // Additional Data Field Template (Tag 62 - Purpose of Transaction Tag 08)
  const additionalData = formatTlv('62', formatTlv('08', transferNote));

  const bodyWithoutCrc =
    formatTlv('00', '01') + // Payload Format Indicator
    formatTlv('01', '12') + // Dynamic QR
    merchantAccountInfo +
    formatTlv('53', '704') + // VND Currency ISO 4217
    formatTlv('54', String(amountVnd)) +
    formatTlv('58', 'VN') +
    additionalData +
    '6304';

  const crc16 = crc16Ccitt(bodyWithoutCrc);
  const emvPayload = `${bodyWithoutCrc}${crc16}`;

  return {
    emvPayload,
    transferNote,
    amountVnd,
    bankBin,
    accountNumber,
    accountHolder,
    crc16,
  };
}
