/**
 * Provisioning the first founder, outside the HTTP surface.
 *
 * The pilot database starts empty. Nothing in the application can grant the first
 * `founder_admin`: `authorize.ts` resolves a role from an existing membership, so
 * before the first row exists every guarded route refuses — including the
 * founder's own. §6 forbids the obvious escape hatches (the first person to log
 * in becomes the admin; an email allowlist that skips the membership check), and
 * a public bootstrap endpoint would be a second authorization system with a
 * different set of mistakes.
 *
 * So the grant is a **provisioning command**: an operator with infrastructure
 * access runs `pnpm bootstrap:founder` against a named database, outside the
 * Worker, and the command writes the workspace, the identity, the membership and
 * one audit row. This module is the whole of that decision — no HTTP route
 * imports it, and the Worker bundle does not contain it.
 *
 * Three rules shape everything below.
 *
 * 1. **The subject is the key, never the email.** An Access subject is what the
 *    verifier checks; an email is a label that can be shared or changed. The
 *    command therefore takes the subject as a required argument and refuses to
 *    derive one.
 * 2. **A refusal is not an update.** A revoked membership, a different role in
 *    the same workspace, or an existing founder are all refusals, not things to
 *    "fix up". Bootstrap is not a membership manager and not an account-recovery
 *    tool.
 * 3. **The audit row says who, as a declaration.** The actor is not an identity in
 *    this system, so the row cannot name an authenticated one. It carries the
 *    operator's own reference and, when given, a ticket, both marked
 *    `operator_reference: 'declared'`. That is deliberately weaker than a
 *    verified actor and deliberately present: a claim next to a timestamp and a
 *    database name is checkable against infrastructure logs, while a missing
 *    actor is not checkable at all.
 * 4. **All or nothing, proved at the transport.** Every write is guarded by the
 *    same precondition predicate, and the command-line transport sends them as one
 *    SQL file. That the file is one transaction was measured locally rather than
 *    inferred from D1 batch semantics: a probe file whose last statement violates a
 *    CHECK leaves every table empty (`test/bootstrap-transport.test.ts`). The audit
 *    row is the gate for the membership, following the pattern
 *    `src/founder/discovery.ts` already uses. A guard that fails writes nothing.
 */

import type { D1Like } from './catalog.ts';

/** The one role this command can grant. Anything else would be a second tool. */
const BOOTSTRAP_ROLE = 'founder_admin';

/** Filled in by the caller, so a test can assert on exact rows. */
export interface BootstrapIdSource {
  identity: string;
  membership: string;
  audit: string;
}

export interface FounderBootstrapInput {
  /** Which database this is, recorded in the audit detail. */
  environment: string;
  workspaceId: string;
  workspaceName: string;
  /** The Access `sub` claim, read by the operator from a verified identity. */
  accessSubject: string;
  /** The email the operator read from the same identity, for cross-checking. */
  email: string;
  /** Why this grant exists. Required: an unexplained admin grant is not auditable. */
  reason: string;
  /**
   * Who ran the command, in the operator's own words — a name, an email, a
   * ticket handle. Recorded in the audit detail.
   *
   * It is a **declaration**, not a verified identity: nothing in this process can
   * prove that the person at the keyboard is the person named, because the actor
   * is not authenticated at all. What makes it useful is that it is written down
   * beside a timestamp and a target database, so it can be checked against the
   * infrastructure's own logs (who held the credentials, who ran the deploy).
   */
  operator: string;
  /** A change, ticket or approval reference, when the organisation has one. */
  ticket?: string;
  /** Seam for tests; defaults to now. */
  timestamp?: string;
  /** Seam for tests; defaults to generated ids. */
  ids?: Partial<BootstrapIdSource>;
}

export type BootstrapRefusalCode =
  | 'invalid_input'
  | 'workspace_name_conflict'
  | 'identity_email_mismatch'
  | 'email_owned_by_another_subject'
  | 'membership_revoked'
  | 'role_conflict'
  | 'founder_exists'
  | 'changed_during_run'
  | 'inconsistent';

export interface BootstrapState {
  workspace: { id: string; name: string } | null;
  identity: { id: string; accessSub: string; email: string | null } | null;
  /** Identities already holding the declared email, whatever their subject. */
  emailHolders: readonly { id: string; accessSub: string; email: string | null }[];
  /** Memberships of this identity in this workspace, live or revoked. */
  pairMemberships: readonly { id: string; role: string; revokedAt: string | null }[];
  /** Every live `founder_admin` in the database, with the identity behind it. */
  activeFounders: readonly { membershipId: string; workspaceId: string; accessSubject: string }[];
}

export type BootstrapDecision =
  | { kind: 'already'; membershipId: string }
  | { kind: 'refuse'; code: BootstrapRefusalCode; message: string }
  | { kind: 'create'; createWorkspace: boolean; createIdentity: boolean };

export interface SqlStatement {
  sql: string;
  params: readonly unknown[];
}

export interface BootstrapCreated {
  workspace: { id: string; name: string; created: boolean };
  identity: { id: string; accessSubject: string; email: string; created: boolean };
  membership: { id: string; role: string; revokedAt: null };
  auditEventId: string;
}

export type BootstrapOutcome =
  | { status: 'CREATED'; created: BootstrapCreated; statements: readonly SqlStatement[] }
  | { status: 'ALREADY'; membershipId: string; message: string }
  | {
      status: 'REFUSED';
      code: BootstrapRefusalCode;
      message: string;
      problems?: readonly string[];
    }
  | { status: 'NOT_WRITTEN'; message: string; state: BootstrapState }
  | { status: 'INCONSISTENT'; message: string; state: BootstrapState };

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Characters no input may contain.
 *
 * The values reach the database through two paths: bound parameters (tests, and
 * anything holding a real D1 binding) and a generated `.sql` file handed to
 * `wrangler d1 execute --file` (the command line). Wrangler splits that file into
 * statements with a tokenizer that does not treat a single quote as opening a
 * literal, so a semicolon inside a string would split a statement in half, and
 * `--` would swallow the rest of the line. Rather than depend on that, the
 * command refuses values where those characters mean something: none of an id, a
 * subject, an email or a one-sentence reason needs them.
 */
const FORBIDDEN = [
  { pattern: /;/, description: 'a semicolon' },
  { pattern: /--/, description: 'a double hyphen' },
  { pattern: /\/\*/, description: 'a comment opener' },
  { pattern: /\*\//, description: 'a comment closer' },
  { pattern: /[\u0000-\u001f\u007f]/, description: 'a control character such as a newline' },
];

const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface BootstrapInputProblem {
  field: string;
  message: string;
}

/** Pure validation, so the plan never depends on a partially checked input. */
export function validateBootstrapInput(input: FounderBootstrapInput): BootstrapInputProblem[] {
  const problems: BootstrapInputProblem[] = [];

  const checkText = (field: string, value: string, max: number): string => {
    const trimmed = value.trim();
    if (trimmed === '') {
      problems.push({ field, message: 'is required' });
      return '';
    }
    if (trimmed.length > max) {
      problems.push({ field, message: `must be at most ${max} characters` });
    }
    for (const entry of FORBIDDEN) {
      if (entry.pattern.test(trimmed)) {
        problems.push({ field, message: `must not contain ${entry.description}` });
        break;
      }
    }
    return trimmed;
  };

  const workspaceId = checkText('workspaceId', input.workspaceId, 64);
  if (workspaceId !== '' && !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    problems.push({
      field: 'workspaceId',
      message: 'must be 3–64 characters of lowercase letters, digits, hyphen or underscore',
    });
  }
  checkText('workspaceName', input.workspaceName, 200);
  checkText('accessSubject', input.accessSubject, 255);
  const email = checkText('email', input.email, 255);
  if (email !== '' && !EMAIL_PATTERN.test(email)) {
    problems.push({ field: 'email', message: 'must look like an email address' });
  }
  const reason = checkText('reason', input.reason, 500);
  if (reason !== '' && reason.length < 8) {
    problems.push({ field: 'reason', message: 'must say something a reader can act on (8+ characters)' });
  }
  checkText('operator', input.operator ?? '', 120);
  // Optional, but validated when present: an empty flag is the same as absent.
  if ((input.ticket ?? '').trim() !== '') checkText('ticket', input.ticket ?? '', 120);
  checkText('environment', input.environment, 32);

  return problems;
}

// ---------------------------------------------------------------------------
// Reading the current state
// ---------------------------------------------------------------------------

/**
 * The whole state in one statement.
 *
 * It used to be five queries. Against a real deployment each one is a round trip,
 * and through the command-line transport each one is a separate `wrangler`
 * process opening the same SQLite file — twelve per apply, which is both slow and
 * the reason two concurrent invocations could trip over each other while merely
 * *reading*. One statement is one snapshot and one process: the state a decision
 * is made from is then internally consistent by construction, not by luck.
 *
 * The rows come back as JSON because a single result set cannot have five shapes.
 * `json_group_array` returns `[]` for no rows and `json_object` returns NULL for
 * no row, so the mapping below never has to guess.
 */
export async function readBootstrapState(
  db: D1Like,
  input: Pick<FounderBootstrapInput, 'workspaceId' | 'accessSubject' | 'email'>,
): Promise<BootstrapState> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT json_object('id', w.id, 'name', w.name)
            FROM workspaces w WHERE w.id = ?) AS workspace,
         (SELECT json_object('id', i.id, 'access_sub', i.access_sub, 'email', i.email)
            FROM identities i WHERE i.access_sub = ?) AS identity,
         (SELECT json_group_array(json_object('id', i.id, 'access_sub', i.access_sub, 'email', i.email))
            FROM identities i WHERE lower(i.email) = lower(?)) AS email_holders,
         (SELECT json_group_array(json_object('id', m.id, 'role', m.role, 'revoked_at', m.revoked_at))
            FROM memberships m JOIN identities i ON i.id = m.identity_id
           WHERE i.access_sub = ? AND m.workspace_id = ?) AS pair_memberships,
         (SELECT json_group_array(
                   json_object('membership_id', m.id, 'workspace_id', m.workspace_id, 'access_sub', i.access_sub))
            FROM memberships m JOIN identities i ON i.id = m.identity_id
           WHERE m.role = ? AND m.revoked_at IS NULL) AS active_founders`,
    )
    .bind(
      input.workspaceId,
      input.accessSubject,
      input.email,
      input.accessSubject,
      input.workspaceId,
      BOOTSTRAP_ROLE,
    )
    .first<{
      workspace: string | null;
      identity: string | null;
      email_holders: string | null;
      pair_memberships: string | null;
      active_founders: string | null;
    }>();

  const parse = <T>(value: string | null, fallback: T): T => {
    if (value === null || value === '') return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      // A malformed aggregate would otherwise read as "nothing exists", which is
      // the one wrong answer this command must never invent.
      throw new Error(`the database returned a state this command cannot read: ${value}`);
    }
  };

  interface WorkspaceJson {
    id: string;
    name: string;
  }
  interface IdentityJson {
    id: string;
    access_sub: string;
    email: string | null;
  }
  interface MembershipJson {
    id: string;
    role: string;
    revoked_at: string | null;
  }
  interface FounderJson {
    membership_id: string;
    workspace_id: string;
    access_sub: string;
  }

  const workspace = parse<WorkspaceJson | null>(row?.workspace ?? null, null);
  const identity = parse<IdentityJson | null>(row?.identity ?? null, null);

  return {
    workspace: workspace === null ? null : { id: workspace.id, name: workspace.name },
    identity:
      identity === null
        ? null
        : { id: identity.id, accessSub: identity.access_sub, email: identity.email },
    emailHolders: parse<IdentityJson[]>(row?.email_holders ?? null, []).map((entry) => ({
      id: entry.id,
      accessSub: entry.access_sub,
      email: entry.email,
    })),
    pairMemberships: parse<MembershipJson[]>(row?.pair_memberships ?? null, []).map((entry) => ({
      id: entry.id,
      role: entry.role,
      revokedAt: entry.revoked_at,
    })),
    activeFounders: parse<FounderJson[]>(row?.active_founders ?? null, []).map((entry) => ({
      membershipId: entry.membership_id,
      workspaceId: entry.workspace_id,
      accessSubject: entry.access_sub,
    })),
  };
}

const sameEmail = (a: string | null, b: string): boolean =>
  a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Decides what the command may do, from a state and the declared input.
 *
 * Every refusal names a condition an operator can check, and none of them is
 * "retry": a revoked membership stays revoked, a different role stays different,
 * and a second founder stays refused.
 */
export function decideFounderBootstrap(
  state: BootstrapState,
  input: FounderBootstrapInput,
): BootstrapDecision {
  const workspaceName = input.workspaceName.trim();
  const email = input.email.trim();

  // A workspace with this id but another name is a different workspace. The
  // command does not rename it, and does not write a membership into it.
  if (state.workspace !== null && state.workspace.name.trim() !== workspaceName) {
    return {
      kind: 'refuse',
      code: 'workspace_name_conflict',
      message:
        `Workspace "${state.workspace.id}" exists as "${state.workspace.name}", not "${workspaceName}". ` +
        'The command does not rename a workspace or grant into one whose name does not match the input.',
    };
  }

  // The subject already has an identity, and it is labelled with another email.
  // Silently rewriting it would make the audit row describe a person who is not
  // the one on file.
  if (state.identity !== null && state.identity.email !== null && !sameEmail(state.identity.email, email)) {
    return {
      kind: 'refuse',
      code: 'identity_email_mismatch',
      message:
        `An identity for subject "${input.accessSubject}" is already recorded with a different email. ` +
        'This command does not change the email of an existing identity.',
    };
  }

  const otherHolder = state.emailHolders.find(
    (row) => row.accessSub !== input.accessSubject && sameEmail(row.email, email),
  );
  if (otherHolder !== undefined) {
    return {
      kind: 'refuse',
      code: 'email_owned_by_another_subject',
      message:
        `The email is already recorded for a different subject ("${otherHolder.accessSub}"). ` +
        'Two identities for one mailbox would make the audit trail ambiguous; resolve the duplicate first.',
    };
  }

  // A revoked membership is history. Re-granting it would erase the reason it was
  // revoked, which is the one thing a revocation is for.
  const revoked = state.pairMemberships.find((row) => row.revokedAt !== null);
  if (revoked !== undefined) {
    return {
      kind: 'refuse',
      code: 'membership_revoked',
      message:
        `A membership for this subject in "${input.workspaceId}" was revoked at ${revoked.revokedAt}. ` +
        'Bootstrap does not restore access; a new grant is a decision for a person, recorded through the app.',
    };
  }

  const liveDifferentRole = state.pairMemberships.find((row) => row.role !== BOOTSTRAP_ROLE);
  if (liveDifferentRole !== undefined) {
    return {
      kind: 'refuse',
      code: 'role_conflict',
      message:
        `This subject already holds "${liveDifferentRole.role}" in "${input.workspaceId}". ` +
        'Bootstrap grants founder_admin or nothing; it never changes an existing role.',
    };
  }

  const liveGrant = state.pairMemberships.find((row) => row.role === BOOTSTRAP_ROLE);
  if (liveGrant !== undefined) {
    return { kind: 'already', membershipId: liveGrant.id };
  }

  const otherFounder = state.activeFounders.find(
    (row) => row.accessSubject !== input.accessSubject,
  );
  if (otherFounder !== undefined) {
    return {
      kind: 'refuse',
      code: 'founder_exists',
      message:
        `A live founder_admin already exists ("${otherFounder.accessSubject}" in "${otherFounder.workspaceId}"). ` +
        'There is one bootstrap per database; a second founder is granted through the application.',
    };
  }

  return {
    kind: 'create',
    createWorkspace: state.workspace === null,
    createIdentity: state.identity === null,
  };
}

// ---------------------------------------------------------------------------
// The write, expressed as statements
// ---------------------------------------------------------------------------

/**
 * The precondition predicate, as SQL.
 *
 * The same fragment guards every insert. Inside one batch there is one
 * transaction, so it is evaluated against one consistent state: either all four
 * inserts happen or none of them do. That is what makes a concurrent second run
 * safe without a lock — the loser's predicate is false and it writes nothing,
 * rather than writing a workspace and failing on the membership.
 */
function precondition(
  input: FounderBootstrapInput,
): { sql: string; params: unknown[] } {
  const clauses = [
    // No workspace with this id under another name.
    `NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ? AND w.name <> ?)`,
    // No identity for this subject labelled with a different email.
    `NOT EXISTS (SELECT 1 FROM identities i
                  WHERE i.access_sub = ? AND i.email IS NOT NULL AND lower(i.email) <> lower(?))`,
    // No other identity holding this email.
    `NOT EXISTS (SELECT 1 FROM identities i
                  WHERE lower(i.email) = lower(?) AND i.access_sub <> ?)`,
    // No revoked membership for this pair.
    `NOT EXISTS (SELECT 1 FROM memberships m
                   JOIN identities i ON i.id = m.identity_id
                  WHERE i.access_sub = ? AND m.workspace_id = ? AND m.revoked_at IS NOT NULL)`,
    // No live membership for this pair under another role.
    `NOT EXISTS (SELECT 1 FROM memberships m
                   JOIN identities i ON i.id = m.identity_id
                  WHERE i.access_sub = ? AND m.workspace_id = ? AND m.role <> ?)`,
    // No live founder_admin belonging to someone else.
    `NOT EXISTS (SELECT 1 FROM memberships m
                   JOIN identities i ON i.id = m.identity_id
                  WHERE m.role = ? AND m.revoked_at IS NULL AND i.access_sub <> ?)`,
    // And no membership for this pair yet. This is what makes a concurrent
    // duplicate write nothing at all: without it, the loser of a race would add
    // an audit row claiming a grant it did not make, because the audit insert
    // precedes the membership.
    `NOT EXISTS (SELECT 1 FROM memberships m
                   JOIN identities i ON i.id = m.identity_id
                  WHERE i.access_sub = ? AND m.workspace_id = ?)`,
  ];
  return {
    sql: clauses.join(' AND '),
    params: [
      input.workspaceId,
      input.workspaceName.trim(),
      input.accessSubject,
      input.email.trim(),
      input.email.trim(),
      input.accessSubject,
      input.accessSubject,
      input.workspaceId,
      input.accessSubject,
      input.workspaceId,
      BOOTSTRAP_ROLE,
      BOOTSTRAP_ROLE,
      input.accessSubject,
      input.accessSubject,
      input.workspaceId,
    ],
  };
}

export interface BootstrapIds extends BootstrapIdSource {
  workspaceId: string;
}

function resolveIds(input: FounderBootstrapInput): BootstrapIds {
  const generated = (prefix: string, suffix: string): string =>
    `${prefix}-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`)
      .replace(/-/g, '')
      .slice(0, 12)}${suffix}`;
  return {
    workspaceId: input.workspaceId.trim(),
    identity: input.ids?.identity ?? generated('id', ''),
    membership: input.ids?.membership ?? generated('mb', ''),
    audit: input.ids?.audit ?? generated('ae', ''),
  };
}

/**
 * The batch, in order: workspace, identity, audit, membership.
 *
 * The audit row is written before the membership and the membership is gated on
 * it, following `src/founder/discovery.ts`: an operation that cannot record what
 * it did does not do it. `actor_id` is NULL because the actor is a person at a
 * terminal, not an identity — `actor_source = 'provisioning'` says so, which is
 * why migration 0007 exists.
 */
export function bootstrapStatements(
  input: FounderBootstrapInput,
  decision: { createWorkspace: boolean; createIdentity: boolean },
  ids: BootstrapIds = resolveIds(input),
): SqlStatement[] {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const workspaceName = input.workspaceName.trim();
  const email = input.email.trim();
  const subject = input.accessSubject.trim();
  const guard = precondition(input);
  const gate = 'EXISTS (SELECT 1 FROM audit_events WHERE id = ?)';

  const detail = JSON.stringify({
    command: 'bootstrap:founder',
    environment: input.environment.trim(),
    reason: input.reason.trim(),
    // Declared by the operator, not verified by this process. The wording is in
    // the row itself so a reader of the audit trail cannot mistake it for an
    // authenticated actor.
    operator: input.operator.trim(),
    operator_reference: 'declared',
    ticket: (input.ticket ?? '').trim() === '' ? null : (input.ticket ?? '').trim(),
    subject_attestation: 'declared-not-verified',
    email,
    access_subject: subject,
    workspace_id: ids.workspaceId,
    workspace_name: workspaceName,
    role: BOOTSTRAP_ROLE,
    created_workspace: decision.createWorkspace,
    created_identity: decision.createIdentity,
  });

  const statements: SqlStatement[] = [];

  // 1. The workspace, if this id does not already have one.
  statements.push({
    sql: `INSERT INTO workspaces (id, name, created_at, updated_at)
          SELECT ?, ?, ?, ?
           WHERE ${guard.sql}
             AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ?)`,
    params: [ids.workspaceId, workspaceName, timestamp, timestamp, ...guard.params, ids.workspaceId],
  });

  // 2. The identity, if this subject has none.
  statements.push({
    sql: `INSERT INTO identities (id, access_sub, email, display_name, created_at)
          SELECT ?, ?, ?, NULL, ?
           WHERE ${guard.sql}
             AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.access_sub = ?)`,
    params: [ids.identity, subject, email, timestamp, ...guard.params, subject],
  });

  // 3. Fill in an email the identity never had. Never overwrites one it has.
  statements.push({
    sql: `UPDATE identities SET email = ?
           WHERE access_sub = ? AND email IS NULL
             AND ${guard.sql}`,
    params: [email, subject, ...guard.params],
  });

  // 4. The audit row — the gate for the membership below.
  statements.push({
    sql: `INSERT INTO audit_events
            (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at, actor_source)
          SELECT ?, ?, NULL, 'membership.granted', 'membership', ?, ?, ?, 'provisioning'
           WHERE ${guard.sql}
             AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ?)
             AND EXISTS (SELECT 1 FROM identities i WHERE i.access_sub = ?)`,
    params: [
      ids.audit,
      ids.workspaceId,
      ids.membership,
      detail,
      timestamp,
      ...guard.params,
      ids.workspaceId,
      subject,
    ],
  });

  // 5. The membership itself, gated on the audit row that justifies it.
  statements.push({
    sql: `INSERT INTO memberships (id, identity_id, workspace_id, role, granted_by, granted_at, revoked_at)
          SELECT ?, i.id, ?, ?, NULL, ?, NULL
            FROM identities i
           WHERE i.access_sub = ?
             AND ${guard.sql}
             AND ${gate}
             AND NOT EXISTS (SELECT 1 FROM memberships m
                              WHERE m.identity_id = i.id AND m.workspace_id = ?)`,
    params: [
      ids.membership,
      ids.workspaceId,
      BOOTSTRAP_ROLE,
      timestamp,
      subject,
      ...guard.params,
      ids.audit,
      ids.workspaceId,
    ],
  });

  return statements;
}

// ---------------------------------------------------------------------------
// Preview and apply
// ---------------------------------------------------------------------------

export interface BootstrapPreview {
  status: 'WOULD_CREATE' | 'ALREADY' | 'REFUSED';
  state: BootstrapState;
  decision: BootstrapDecision;
  statementCount: number;
}

/**
 * Reads and decides, and writes nothing.
 *
 * This is the default mode of the command: an operator sees the target, the rows
 * that would appear and the condition that would refuse, before any of it runs.
 */
export async function previewFounderBootstrap(
  db: D1Like,
  input: FounderBootstrapInput,
): Promise<BootstrapPreview> {
  const problems = validateBootstrapInput(input);
  if (problems.length > 0) {
    return {
      status: 'REFUSED',
      state: emptyState(),
      decision: {
        kind: 'refuse',
        code: 'invalid_input',
        message: problems.map((p) => `${p.field} ${p.message}`).join('; '),
      },
      statementCount: 0,
    };
  }
  const state = await readBootstrapState(db, input);
  const decision = decideFounderBootstrap(state, input);
  return {
    status:
      decision.kind === 'create' ? 'WOULD_CREATE' : decision.kind === 'already' ? 'ALREADY' : 'REFUSED',
    state,
    decision,
    statementCount: decision.kind === 'create' ? bootstrapStatements(input, decision).length : 0,
  };
}

function emptyState(): BootstrapState {
  return {
    workspace: null,
    identity: null,
    emailHolders: [],
    pairMemberships: [],
    activeFounders: [],
  };
}

/**
 * Applies the batch, then reads the result back from the database.
 *
 * The read-back is not decoration: it is the only proof that the rows exist, and
 * it is what distinguishes "wrote nothing because the state moved under us" from
 * "wrote something unexpected". Either way the caller is told exactly what is in
 * the database now, rather than what the command intended.
 */
export async function applyFounderBootstrap(
  db: D1Like,
  input: FounderBootstrapInput,
): Promise<BootstrapOutcome> {
  const problems = validateBootstrapInput(input);
  if (problems.length > 0) {
    return {
      status: 'REFUSED',
      code: 'invalid_input',
      message: problems.map((p) => `${p.field} ${p.message}`).join('; '),
      problems: problems.map((p) => `${p.field} ${p.message}`),
    };
  }

  const before = await readBootstrapState(db, input);
  const decision = decideFounderBootstrap(before, input);

  if (decision.kind === 'refuse') {
    return { status: 'REFUSED', code: decision.code, message: decision.message };
  }

  if (decision.kind === 'already') {
    return {
      status: 'ALREADY',
      membershipId: decision.membershipId,
      message:
        'This subject already holds a live founder_admin membership in this workspace. ' +
        'Nothing was written: no second membership, no second audit row.',
    };
  }

  const ids = resolveIds(input);
  const statements = bootstrapStatements(input, decision, ids);
  const prepared = statements.map((statement) => db.prepare(statement.sql).bind(...statement.params));
  // One call. The transport is responsible for atomicity: the command line turns
  // this batch into one SQL file, and that file has been measured to commit or
  // roll back as a unit (see the module header). The read-back below is what
  // decides whether the rows are actually there.
  await db.batch(prepared);

  const after = await readBootstrapState(db, input);
  const membership = after.pairMemberships.find((row) => row.id === ids.membership);

  if (membership === undefined) {
    return {
      status: 'NOT_WRITTEN',
      message:
        'The batch wrote nothing: a precondition changed between the read and the write. ' +
        'Run the preview again to see the current state and the condition that now refuses.',
      state: after,
    };
  }

  const auditRow = await db
    .prepare(
      `SELECT id, action, subject_type, subject_id, actor_id, actor_source
         FROM audit_events WHERE id = ?`,
    )
    .bind(ids.audit)
    .first<{
      id: string;
      action: string;
      subject_type: string;
      subject_id: string;
      actor_id: string | null;
      actor_source: string;
    }>();

  const problemsAfter: string[] = [];
  if (after.workspace === null || after.workspace.name !== input.workspaceName.trim()) {
    problemsAfter.push('the workspace is missing or has another name');
  }
  if (after.identity === null || !sameEmail(after.identity.email, input.email)) {
    problemsAfter.push('the identity is missing or carries another email');
  }
  if (membership.role !== BOOTSTRAP_ROLE || membership.revokedAt !== null) {
    problemsAfter.push('the membership is not a live founder_admin');
  }
  if (auditRow === null) {
    problemsAfter.push('the audit row is missing');
  } else if (auditRow.actor_source !== 'provisioning' || auditRow.actor_id !== null) {
    problemsAfter.push('the audit row does not record a provisioning actor');
  }
  if (after.activeFounders.length !== 1) {
    problemsAfter.push(`there are ${after.activeFounders.length} live founders, expected exactly 1`);
  }

  if (problemsAfter.length > 0) {
    return {
      status: 'INCONSISTENT',
      message: `The command did not leave the database as asked: ${problemsAfter.join('; ')}.`,
      state: after,
    };
  }

  return {
    status: 'CREATED',
    statements,
    created: {
      workspace: {
        id: ids.workspaceId,
        name: input.workspaceName.trim(),
        created: decision.createWorkspace,
      },
      identity: {
        id: after.identity?.id ?? ids.identity,
        accessSubject: input.accessSubject.trim(),
        email: input.email.trim(),
        created: decision.createIdentity,
      },
      membership: { id: ids.membership, role: BOOTSTRAP_ROLE, revokedAt: null },
      auditEventId: ids.audit,
    },
  };
}

// ---------------------------------------------------------------------------
// Serialising for `wrangler d1 execute`
// ---------------------------------------------------------------------------

/**
 * A SQL literal for a value, for the one path that cannot bind parameters.
 *
 * `wrangler d1 execute` accepts a file of SQL, not a list of (sql, params) pairs,
 * and the provisioning command has to reach a remote database through it. This
 * function is the boundary between the two, so it is deliberately narrow:
 * numbers are numbers, strings are quoted with the standard doubled-quote escape,
 * null is NULL, and anything else is refused rather than stringified into SQL.
 *
 * The values that reach it have already been through `validateBootstrapInput`,
 * which is what keeps `;` and `--` out of them; the quoting here is the second
 * line, not the only one.
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Refusing to write a non-finite number as SQL: ${value}`);
    return String(value);
  }
  if (typeof value === 'string') {
    if (/[\u0000]/.test(value)) throw new Error('Refusing to write a NUL character as SQL');
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new Error(`Refusing to write a ${typeof value} as SQL`);
}

/** The statements as one script, each parameter bound into the text. */
export function renderSqlScript(statements: readonly SqlStatement[]): string {
  return statements
    .map((statement) => {
      let index = 0;
      // Placeholders are positional and unambiguous because every `?` in these
      // statements is a value, never part of a literal.
      const text = statement.sql.replace(/\?/g, () => sqlLiteral(statement.params[index++]));
      if (index !== statement.params.length) {
        throw new Error(
          `Statement used ${index} parameters but ${statement.params.length} were bound:\n${statement.sql}`,
        );
      }
      return `${text};`;
    })
    .join('\n\n');
}
