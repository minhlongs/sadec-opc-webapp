/**
 * Cryptographically signed Lot & Package QR Token Engine (HMAC-SHA256 via Web Crypto API).
 *
 * Used at:
 *  - Checkpoint 0: Nursery registers a supply lot in Sa Đéc (`LOT`)
 *  - Checkpoint 1: Sa Đéc Hub verifies physical crate & attaches QR (`PKG`)
 *  - Checkpoint 2: TP.HCM Shop scans QR to inspect and trigger escrow settlement
 */

export type QrEntityKind = 'LOT' | 'PKG';

export interface LotQrClaims {
  kind: QrEntityKind;
  entityId: string;
  workspaceId: string;
  issuedAt: string;
}

const DEFAULT_DEV_QR_SECRET = 'sadec-b2b-lot-qr-local-signing-key-2026';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const base64 = padded + '='.repeat(padLen);
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret.trim() === '' ? DEFAULT_DEV_QR_SECRET : secret);
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Signs a Lot or Package QR token with HMAC-SHA256.
 * Format: `SDECQR.<base64url(claims)>.<base64url(signature)>`
 */
export async function signLotQrToken(
  claims: LotQrClaims,
  secret: string = DEFAULT_DEV_QR_SECRET,
): Promise<string> {
  if (claims.entityId.trim() === '' || claims.workspaceId.trim() === '') {
    throw new Error('entityId and workspaceId are required to sign QR token');
  }
  const encoder = new TextEncoder();
  const payloadJson = JSON.stringify({
    kind: claims.kind,
    entityId: claims.entityId,
    workspaceId: claims.workspaceId,
    issuedAt: claims.issuedAt,
  });
  const payloadB64 = toBase64Url(encoder.encode(payloadJson));
  const key = await importHmacKey(secret);
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`SDECQR.${payloadB64}`),
  );
  const sigB64 = toBase64Url(new Uint8Array(signatureBuffer));
  return `SDECQR.${payloadB64}.${sigB64}`;
}

/**
 * Verifies an HMAC-SHA256 QR token and returns its parsed claims, or null if tampered.
 */
export async function verifyLotQrToken(
  token: string,
  secret: string = DEFAULT_DEV_QR_SECRET,
): Promise<LotQrClaims | null> {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'SDECQR') {
    return null;
  }
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;

  const sigBytes = fromBase64Url(sigB64);
  const payloadBytes = fromBase64Url(payloadB64);
  if (sigBytes === null || payloadBytes === null) {
    return null;
  }

  const encoder = new TextEncoder();
  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    encoder.encode(`SDECQR.${payloadB64}`),
  );
  if (!valid) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<LotQrClaims>;
    if (
      (parsed.kind === 'LOT' || parsed.kind === 'PKG') &&
      typeof parsed.entityId === 'string' &&
      parsed.entityId.length > 0 &&
      typeof parsed.workspaceId === 'string' &&
      parsed.workspaceId.length > 0 &&
      typeof parsed.issuedAt === 'string'
    ) {
      return {
        kind: parsed.kind,
        entityId: parsed.entityId,
        workspaceId: parsed.workspaceId,
        issuedAt: parsed.issuedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}
