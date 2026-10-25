/**
 * The local development identity adapter.
 *
 * §6 permits it, and constrains it in four ways that are easy to violate by
 * accident and impossible to violate here on purpose:
 *
 *   1. It exists only in local and test. A deployment has no code path that
 *      reaches it, which is why this module is chosen by the Worker's
 *      environment check rather than imported and called from a route.
 *   2. It cannot be activated by anything the client sends. There is no query,
 *      cookie, email header or role input that turns it on — a request cannot
 *      widen its own identity, because nothing a request carries is read here.
 *   3. The identity it produces is a labelled demo identity, so §5's requirement
 *      that a demo session show it is using demo data is satisfiable by reading
 *      one field rather than by trusting a banner.
 *   4. It never grants founder_admin to whoever logs in first. §6 forbids that
 *      path, so this adapter returns the demo operator by default and the
 *      founder identity only when the configuration names it.
 *
 * `APP_ENV` is read once at module load from the environment, not from the
 * request. That is the whole guard.
 */

/** The environments where the adapter may be used at all. */
const PERMITTED_ENVIRONMENTS: ReadonlySet<string> = new Set(['local', 'test']);

/** The three demo identities the seed creates, and their roles. */
export interface DemoIdentity {
  accessSubject: string;
  email: string | null;
  displayName: string;
  role: 'founder_admin' | 'workspace_owner' | 'workspace_operator';
  workspaceId: string;
}

export const DEMO_IDENTITIES: readonly DemoIdentity[] = [
  {
    accessSubject: 'demo:sub:admin',
    email: 'admin@example.test',
    displayName: 'DEMO — Founder',
    role: 'founder_admin',
    workspaceId: 'ws-demo-a',
  },
  {
    accessSubject: 'demo:sub:owner',
    email: 'owner@example.test',
    displayName: 'DEMO — Chủ vườn',
    role: 'workspace_owner',
    workspaceId: 'ws-demo-a',
  },
  {
    accessSubject: 'demo:sub:operator',
    email: 'operator@example.test',
    displayName: 'DEMO — Nhân viên',
    role: 'workspace_operator',
    workspaceId: 'ws-demo-a',
  },
];

/** The identity used when a developer has not chosen one. */
const DEFAULT_IDENTITY = 'demo:sub:operator';

/**
 * Whether the adapter is available in this environment.
 *
 * Reads the resolved environment rather than a request, so there is nothing a
 * caller can send that changes the answer. An unset or unknown environment is
 * not a local one, which keeps an unconfigured deployment closed rather than
 * convenient.
 */
export function devIdentityIsAvailable(environment: string | undefined): boolean {
  if (environment === undefined) return false;
  return PERMITTED_ENVIRONMENTS.has(environment.trim().toLowerCase());
}

/**
 * Resolves the demo identity for a local or test session.
 *
 * The subject comes from the configuration (`DEV_IDENTITY_SUBJECT`), never from
 * the request. An unset value yields the operator — the least-privileged identity
 * — so a developer who names nobody still has a working session and never an
 * administrative one.
 *
 * A configured subject that matches no demo identity returns null rather than a
 * default. That is deliberate: a typo in the configuration should stop the
 * session, not quietly resolve to a lower role and let the developer believe they
 * are testing as the identity they named.
 */
export function resolveDevIdentity(
  environment: string | undefined,
  configuredSubject: string | undefined,
): DemoIdentity | null {
  if (!devIdentityIsAvailable(environment)) return null;

  const wanted = configuredSubject?.trim();
  if (wanted === undefined || wanted === '') {
    return DEMO_IDENTITIES.find((entry) => entry.accessSubject === DEFAULT_IDENTITY) ?? null;
  }

  return DEMO_IDENTITIES.find((entry) => entry.accessSubject === wanted) ?? null;
}

/** The label a UI shows so a demo session never looks like a real one. */
export const DEMO_IDENTITY_LABEL = 'Danh tính DEMO — chỉ dùng khi phát triển';
