import { describe, expect, it } from 'vitest';
import { authorize, denialMessage, PERMITTED_ROLES } from '../src/security/authorize.ts';
import type { MembershipStore, Role } from '../src/security/authorize.ts';

/**
 * An in-memory membership store. The chokepoint depends on this interface rather
 * than on D1, so the authorization rules can be tested without a database and a
 * lane cannot weaken them by changing how a query is written.
 */
function storeWith(
  rows: { accessSubject: string; workspaceId: string; identityId: string; role: Role; revokedAt?: string | null }[],
): MembershipStore {
  return {
    async findBySubject(accessSubject, workspaceId) {
      const row = rows.find(
        (r) => r.accessSubject === accessSubject && r.workspaceId === workspaceId,
      );
      if (row === undefined) return null;
      return { identityId: row.identityId, role: row.role, revokedAt: row.revokedAt ?? null };
    },
    // Derived from the same rows rather than declared per test, so a store
    // describes one set of memberships and both views of it agree. Revoked rows
    // are excluded, matching the query's `revoked_at IS NULL`.
    async listBySubject(accessSubject) {
      return rows
        .filter((r) => r.accessSubject === accessSubject && (r.revokedAt ?? null) === null)
        .map((r) => ({ workspaceId: r.workspaceId, role: r.role }));
    },
  };
}

const OPERATOR = {
  accessSubject: 'sub-operator',
  workspaceId: 'ws-a',
  identityId: 'id-op',
  role: 'workspace_operator' as Role,
};
const OWNER = {
  accessSubject: 'sub-owner',
  workspaceId: 'ws-a',
  identityId: 'id-owner',
  role: 'workspace_owner' as Role,
};
const FOUNDER = {
  accessSubject: 'sub-founder',
  workspaceId: 'ws-a',
  identityId: 'id-founder',
  role: 'founder_admin' as Role,
};

describe('the boundaries §6 draws', () => {
  it('lets an operator sell, but not confirm a deposit', async () => {
    const store = storeWith([OPERATOR]);
    expect(
      await authorize(store, {
        accessSubject: OPERATOR.accessSubject,
        action: 'order.write',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'authorized' });

    // §7.3: a deposit is confirmed by someone with the right role. This is the
    // case the founder cannot verify by clicking, so it carries its own refusal.
    expect(
      await authorize(store, {
        accessSubject: OPERATOR.accessSubject,
        action: 'receipt.confirm',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'denied', reason: 'wrong_role' });
  });

  it('lets an owner confirm a deposit', async () => {
    const store = storeWith([OWNER]);
    expect(
      await authorize(store, {
        accessSubject: OWNER.accessSubject,
        action: 'receipt.confirm',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'authorized' });
  });

  it('keeps a workspace role out of the founder area entirely', async () => {
    const store = storeWith([OWNER, OPERATOR]);
    for (const member of [OWNER, OPERATOR]) {
      expect(
        await authorize(store, {
          accessSubject: member.accessSubject,
          action: 'founder.parameter.publish',
          workspaceId: 'ws-a',
        }),
      ).toMatchObject({ kind: 'denied', reason: 'wrong_role' });

      expect(
        await authorize(store, {
          accessSubject: member.accessSubject,
          action: 'founder.parameter.read',
          workspaceId: 'ws-a',
        }),
      ).toMatchObject({ kind: 'denied', reason: 'wrong_role' });
    }
  });

  it('lets only the founder grant or revoke membership', async () => {
    const store = storeWith([OWNER, FOUNDER]);
    expect(
      await authorize(store, {
        accessSubject: OWNER.accessSubject,
        action: 'membership.grant',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'denied', reason: 'wrong_role' });

    expect(
      await authorize(store, {
        accessSubject: FOUNDER.accessSubject,
        action: 'membership.grant',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'authorized' });
  });
});

describe('failure closes rather than opens', () => {
  it('refuses an identity with no membership at all', async () => {
    expect(
      await authorize(storeWith([]), {
        accessSubject: 'sub-stranger',
        action: 'product.read',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'denied', reason: 'no_membership' });
  });

  it('refuses once a membership has been revoked, without deleting it', async () => {
    const store = storeWith([{ ...OPERATOR, revokedAt: '2026-10-24T00:00:00.000Z' }]);
    expect(
      await authorize(store, {
        accessSubject: OPERATOR.accessSubject,
        action: 'order.read',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'denied', reason: 'no_membership' });
  });

  it('refuses a caller who names a workspace they do not belong to', async () => {
    // The tampered workspace id changes nothing: the lookup is by identity, so
    // there is simply no membership for this person in that workspace.
    const store = storeWith([OPERATOR]);
    expect(
      await authorize(store, {
        accessSubject: OPERATOR.accessSubject,
        action: 'product.read',
        workspaceId: 'ws-b',
      }),
    ).toMatchObject({ kind: 'denied', reason: 'no_membership' });
  });

  it('refuses an action nobody declared', async () => {
    const store = storeWith([FOUNDER]);
    expect(
      await authorize(store, {
        accessSubject: FOUNDER.accessSubject,
        action: 'nobody.declared.this',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'denied' });
  });

  it('refuses a missing identity', async () => {
    expect(
      await authorize(storeWith([OWNER]), {
        accessSubject: null,
        action: 'product.read',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'denied', reason: 'no_identity' });
  });

  it('refuses a blank identity rather than treating it as one', async () => {
    expect(
      await authorize(storeWith([OWNER]), {
        accessSubject: '   ',
        action: 'product.read',
        workspaceId: 'ws-a',
      }),
    ).toMatchObject({ kind: 'denied', reason: 'no_identity' });
  });
});

describe('PERMITTED_ROLES', () => {
  it('never lets a workspace role publish founder parameters', () => {
    for (const [action, roles] of Object.entries(PERMITTED_ROLES)) {
      if (!action.startsWith('founder.')) continue;
      expect(roles, `${action} must be founder only`).toEqual(['founder_admin']);
    }
  });

  it('never lets an operator confirm a deposit or change settings', () => {
    for (const action of ['receipt.confirm', 'receipt.reverse', 'membership.grant']) {
      expect(PERMITTED_ROLES[action]).not.toContain('workspace_operator');
    }
  });

  it('gives every declared action at least one role, so no action is dead', () => {
    for (const [action, roles] of Object.entries(PERMITTED_ROLES)) {
      expect(roles.length, `${action} has no role`).toBeGreaterThan(0);
    }
  });
});

describe('denialMessage', () => {
  it('gives a readable reason in Vietnamese for every denial kind', () => {
    expect(denialMessage('no_identity')).toMatch(/đăng nhập/);
    expect(denialMessage('no_membership')).toMatch(/workspace/);
    expect(denialMessage('wrong_workspace')).toMatch(/workspace/);
    expect(denialMessage('wrong_role')).toMatch(/vai trò/i);
  });
});
