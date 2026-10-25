import { describe, expect, it } from 'vitest';
import { signLotQrToken, verifyLotQrToken } from '../src/domain/lot-qr.ts';

describe('signLotQrToken and verifyLotQrToken', () => {
  it('signs and verifies a LOT QR token using HMAC-SHA256', async () => {
    const token = await signLotQrToken(
      {
        kind: 'LOT',
        entityId: 'lot-w-01',
        workspaceId: 'ws-demo-c',
        issuedAt: '2026-10-25T08:00:00.000Z',
      },
      'test-secret-key',
    );

    expect(token.startsWith('SDECQR.')).toBe(true);
    const verified = await verifyLotQrToken(token, 'test-secret-key');
    expect(verified).toEqual({
      kind: 'LOT',
      entityId: 'lot-w-01',
      workspaceId: 'ws-demo-c',
      issuedAt: '2026-10-25T08:00:00.000Z',
    });
  });

  it('signs and verifies a PKG QR token at Sa Đéc Hub', async () => {
    const token = await signLotQrToken(
      {
        kind: 'PKG',
        entityId: 'pkg-demo-01',
        workspaceId: 'ws-demo-a',
        issuedAt: '2026-10-25T09:00:00.000Z',
      },
      'test-secret-key',
    );

    const verified = await verifyLotQrToken(token, 'test-secret-key');
    expect(verified?.kind).toBe('PKG');
    expect(verified?.entityId).toBe('pkg-demo-01');
  });

  it('refuses a token signed with a different secret or tampered payload', async () => {
    const token = await signLotQrToken(
      {
        kind: 'LOT',
        entityId: 'lot-w-01',
        workspaceId: 'ws-demo-c',
        issuedAt: '2026-10-25T08:00:00.000Z',
      },
      'secret-a',
    );

    expect(await verifyLotQrToken(token, 'secret-b')).toBeNull();
    expect(await verifyLotQrToken(`${token}tampered`, 'secret-a')).toBeNull();
  });
});
