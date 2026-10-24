/**
 * The single authorization chokepoint.
 *
 * Every route resolves identity, role and workspace through this module and
 * nothing else. There is one way to answer "may this identity do this", so one
 * review covers every route, and a lane cannot write its own weaker check.
 *
 * Two rules are enforced here rather than in handlers, because both are the kind
 * of thing a later edit removes without noticing:
 *
 *   - Trust never enters from the request. §6 forbids trusting an email, user
 *     id, workspace id or role that a browser sends, so all four are read from
 *     the verified Access token and the membership table, and none is read
 *     from a header, query or body.
 *
 *   - Failure closes. An unknown identity, a missing membership, or a member
 *     whose access was revoked all produce a refusal. Nothing here returns
 *     "allowed" on an empty or unreadable path.
 */

/** The three roles §6 defines, and no fourth. */
export type Role = 'founder_admin' | 'workspace_owner' | 'workspace_operator';

/** Everything a handler needs to know about who is asking. */
export interface Authorization {
  identityId: string;
  /** The subject claim from the verified Access token. */
  accessSubject: string;
  role: Role;
  workspaceId: string;
}

/** Why an authorization was refused. Carries the reason, never a guess. */
export type DenialReason =
  | 'no_identity'
  | 'no_membership'
  | 'wrong_workspace'
  | 'wrong_role';

export type AuthorizationResult =
  | { kind: 'authorized'; authorization: Authorization }
  | { kind: 'denied'; reason: DenialReason };

function denied(reason: DenialReason): AuthorizationResult {
  return { kind: 'denied', reason };
}

/**
 * The membership store this module reads.
 *
 * Declared here as an interface so the chokepoint depends on a capability
 * rather than on D1's API. A test can supply an in-memory one, and the Worker
 * supplies the real one.
 */
export interface MembershipStore {
  /** Finds the membership for an identity in a workspace, if one exists. */
  findBySubject(
    accessSubject: string,
    workspaceId: string,
  ): Promise<{ identityId: string; role: Role; revokedAt: string | null } | null>;
}

/**
 * The roles allowed to perform each family of operation.
 *
 * Stated as data so the boundaries are readable in one place and a new
 * operation cannot quietly inherit a wider permission than its neighbours.
 * §6: an operator does sales and orders and changes neither permissions nor OPC
 * parameters; only an owner confirms a deposit; the founder administers.
 */
export const PERMITTED_ROLES: Readonly<Record<string, readonly Role[]>> = {
  // Nursery operations.
  'product.read': ['founder_admin', 'workspace_owner', 'workspace_operator'],
  'product.write': ['founder_admin', 'workspace_owner'],
  'customer.read': ['founder_admin', 'workspace_owner', 'workspace_operator'],
  'customer.write': ['founder_admin', 'workspace_owner', 'workspace_operator'],
  'quote.read': ['founder_admin', 'workspace_owner', 'workspace_operator'],
  'quote.write': ['founder_admin', 'workspace_owner', 'workspace_operator'],
  'order.read': ['founder_admin', 'workspace_owner', 'workspace_operator'],
  'order.write': ['founder_admin', 'workspace_owner', 'workspace_operator'],
  // §7.3: a deposit is confirmed by someone with the right role, and an operator
  // is not that person. A confirmed receipt is never edited or deleted.
  'receipt.confirm': ['founder_admin', 'workspace_owner'],
  'receipt.reverse': ['founder_admin', 'workspace_owner'],
  'delivery.override_under_deposit': ['founder_admin', 'workspace_owner'],
  // Founder's area. §6: research notes, willingness to pay and the financial
  // model never return on a workspace-scoped request.
  'founder.parameter.publish': ['founder_admin'],
  'founder.parameter.read': ['founder_admin'],
  'workspace.setting.write': ['founder_admin', 'workspace_owner'],
  // Administration.
  'membership.grant': ['founder_admin'],
  'membership.revoke': ['founder_admin'],
};

/**
 * Resolves what an identity may do.
 *
 * The workspace comes from the membership lookup rather than from the request,
 * so a tampered workspace id changes nothing: the answer is whichever workspace
 * the caller actually belongs to, and no other.
 */
export async function authorize(
  store: MembershipStore,
  request: {
    accessSubject: string | null;
    action: string;
    /** The workspace the request names. Never trusted on its own. */
    workspaceId: string | null;
  },
): Promise<AuthorizationResult> {
  if (request.accessSubject === null || request.accessSubject.trim() === '') {
    return denied('no_identity');
  }

  const permitted = PERMITTED_ROLES[request.action];

  // An unknown action is refused. A permission nobody declared is not a
  // permission that exists.
  if (permitted === undefined) return denied('wrong_role');

  if (request.workspaceId === null || request.workspaceId.trim() === '') {
    return denied('no_membership');
  }

  const membership = await store.findBySubject(
    request.accessSubject,
    request.workspaceId,
  );

  if (membership === null) return denied('no_membership');

  // Revocation is checked here rather than by deleting the row, because a
  // deleted row takes its audit history with it and §14 asks for history to
  // survive.
  if (membership.revokedAt !== null) return denied('no_membership');

  if (!permitted.includes(membership.role)) return denied('wrong_role');

  return {
    kind: 'authorized',
    authorization: {
      identityId: membership.identityId,
      accessSubject: request.accessSubject,
      role: membership.role,
      workspaceId: request.workspaceId,
    },
  };
}

/** A readable Vietnamese sentence for a denial, for the response body. */
export function denialMessage(reason: DenialReason): string {
  switch (reason) {
    case 'no_identity':
      return 'Bạn chưa đăng nhập.';
    case 'no_membership':
    case 'wrong_workspace':
      return 'Bạn không thuộc workspace này.';
    case 'wrong_role':
      return 'Vai trò của bạn không được phép thực hiện thao tác này.';
  }
}
