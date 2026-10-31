/**
 * Dynamic VietQR EMVCo ISO/IEC 18004 NAPAS 247 Generator for B2B Escrow Deposits & Settlement.
 *
 * Uses polynomial 0x1021, initial value 0xFFFF for CRC16-CCITT.
 */

import { assertSafeVnd } from './money.ts';

export type VietQrPhase = 'DEP' | 'BAL';

/**
 * The account a deposit is paid into. It is **configuration, never a constant**
 * in the source: the payload this module builds is one a buyer can scan and
 * pay, so a placeholder account number in code would be an instruction to send
 * real money to an account the platform does not control.
 */
export interface EscrowAccount {
  bankBin: string;
  accountNumber: string;
  accountHolder: string;
}

export interface VietQrPayloadInput extends EscrowAccount {
  amountVnd: number;
  bookingCode: string;
  phase: VietQrPhase;
}

/**
 * Reads the escrow account from the environment. Returns null unless all three
 * parts are present and plausible, which is the state of every deployment and
 * of the local demo until somebody configures a real account. A null account
 * means no QR is shown — the booking still exists, and a founder records the
 * deposit against a bank reference they verified themselves.
 */
export function escrowAccountFrom(env: Record<string, unknown>): EscrowAccount | null {
  const bankBin = typeof env.ESCROW_BANK_BIN === 'string' ? env.ESCROW_BANK_BIN.trim() : '';
  const accountNumber =
    typeof env.ESCROW_ACCOUNT_NUMBER === 'string' ? env.ESCROW_ACCOUNT_NUMBER.trim() : '';
  const accountHolder =
    typeof env.ESCROW_ACCOUNT_HOLDER === 'string' ? env.ESCROW_ACCOUNT_HOLDER.trim() : '';
  if (!/^\d{6}$/.test(bankBin)) return null;
  if (!/^\d{6,20}$/.test(accountNumber)) return null;
  if (accountHolder.length < 3) return null;
  return { bankBin, accountNumber, accountHolder };
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
  bankBin,
  accountNumber,
  accountHolder,
  amountVnd,
  bookingCode,
  phase,
}: VietQrPayloadInput): VietQrPayloadResult {
  assertSafeVnd(amountVnd);
  if (amountVnd <= 0) {
    throw new RangeError(`VietQR amount must be positive integer VND: ${amountVnd}`);
  }
  if (!/^\d{6}$/.test(bankBin.trim()) || !/^\d{6,20}$/.test(accountNumber.trim())) {
    throw new RangeError('A valid bank BIN and account number are required for a VietQR payload');
  }
  if (accountHolder.trim().length < 3) {
    throw new RangeError('An account holder name is required for a VietQR payload');
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

/**
 * Builds the payload only when an account is configured.
 *
 * Callers use this instead of `buildVietQrEscrowPayload` so the unconfigured
 * case is a value they must render (`null` → "chưa cấu hình tài khoản nhận
 * cọc, đừng chuyển tiền") rather than a throw, and so no code path can fall
 * back to a built-in account number.
 */
export function tryBuildVietQrEscrowPayload(
  account: EscrowAccount | null,
  input: { amountVnd: number; bookingCode: string; phase: VietQrPhase },
): VietQrPayloadResult | null {
  if (account === null) return null;
  return buildVietQrEscrowPayload({ ...account, ...input });
}
