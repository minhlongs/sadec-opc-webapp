import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import worker, { setMembershipStore, setVerifier } from '../src/worker/index.ts';
import {
  applyFounderBootstrap,
  bootstrapStatements,
  decideFounderBootstrap,
  previewFounderBootstrap,
  readBootstrapState,
  renderSqlScript,
  sqlLiteral,
  validateBootstrapInput,
  type FounderBootstrapInput,
} from '../src/ops/founder-bootstrap.ts';
import {
  COMMAND_ENVIRONMENTS,
  requireEnvironment,
  type ProcessPort,
} from '../scripts/require-environment.ts';
import { missingDeployConfiguration } from '../scripts/deploy-requirements.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';

/**
 * The first founder, provisioned outside the HTTP surface.
 *
 * These tests start from the state that blocked the pilot: a database with every
 * migration applied and no rows in it. Before `pnpm bootstrap:founder` exists,
 * that database refuses the founder herself — the first test keeps that fact
 * visible rather than assuming it away, because "it works after the bootstrap" is
 * only meaningful next to "it does not work before".
 *
 * Everything below runs against the real migration files (including the
 * `actor_source` column from 0007), the real decision logic, and — for the
 * authorization claims — the real Worker's `fetch`, with the real Access
 * verifier replaced by a stub returning a fixed subject. What is stubbed is the
 * *token*, not the guard: `resolveIdentity` still refuses a request that carries
 * no verified identity, and `authorize.ts` still resolves the role from the
 * membership row.
 */

const ORIGIN = 'https://pilot.example.test';
const CTX: { access?: unknown } = {};

const WORKSPACE_ID = 'ws-pilot';
const WORKSPACE_NAME = 'Vườn pilot';
const SUBJECT = 'access-sub-founder-0001';
const EMAIL = 'founder@pilot.example.test';

const TS = '2026-10-30T09:00:00.000Z';

const INPUT: FounderBootstrapInput = {
  environment: 'pilot',
  workspaceId: WORKSPACE_ID,
  workspaceName: WORKSPACE_NAME,
  accessSubject: SUBJECT,
  email: EMAIL,
  reason: 'Pilot 2026-11: first founder for the private preview',
  operator: 'ops:release-drill',
  ticket: 'CHG-2026-11-01',
  timestamp: TS,
  ids: { identity: 'id-pilot-founder', membership: 'mb-pilot-founder', audit: 'ae-pilot-bootstrap' },
};

type Harness = ReturnType<typeof createSqliteD1>;

function counts(harness: Harness): {
  workspaces: number;
  identities: number;
  memberships: number;
  audit: number;
} {
  const read = (table: string): number =>
    Number(
      (harness.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n,
    );
  return {
    workspaces: read('workspaces'),
    identities: read('identities'),
    memberships: read('memberships'),
    audit: read('audit_events'),
  };
}

/** The Worker environment for a deployment: pilot binding, no dev identity. */
function pilotEnv(harness: Harness): Record<string, unknown> {
  return { APP_ENV: 'pilot', sadec_pilot: harness.db };
}

/** Verifies a token header into a fixed identity, or refuses when absent. */
function verifierFor(subject: string, email: string | null) {
  return async (header: string | null) =>
    header === null ? null : { accessSubject: subject, email };
}

function request(path: string, workspaceId?: string, init: RequestInit = {}): Request {
  const url = new URL(path, ORIGIN);
  if (workspaceId !== undefined) url.searchParams.set('workspace_id', workspaceId);
  return new Request(url, init);
}

function withToken(request_: Request, token = 'verified-token'): Request {
  const headers = new Headers(request_.headers);
  headers.set('Cf-Access-Jwt-Assertion', token);
  return new Request(request_, { headers });
}

describe('a pilot database with no rows refuses everyone, including the founder', () => {
  it('answers 403 to the verified founder before any bootstrap has run', async () => {
    const harness = createSqliteD1({ seedDemo: false });
    setMembershipStore(null);
    setVerifier(verifierFor(SUBJECT, EMAIL));

    const response = await worker.fetch(
      withToken(request('/api/session')),
      pilotEnv(harness),
      CTX,
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; code?: string };
    expect(body.code).toBe('forbidden');
    expect(body.error).toBe('Bạn không thuộc workspace nào.');
    expect(counts(harness)).toEqual({ workspaces: 0, identities: 0, memberships: 0, audit: 0 });

    setVerifier(null);
  });
});

describe('the bootstrap plan', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createSqliteD1({ seedDemo: false });
    setMembershipStore(null);
  });

  afterEach(() => {
    setVerifier(null);
  });

  it('preview reports the rows it would write and writes none of them', async () => {
    const preview = await previewFounderBootstrap(harness.db, INPUT);

    expect(preview.status).toBe('WOULD_CREATE');
    expect(preview.decision).toEqual({ kind: 'create', createWorkspace: true, createIdentity: true });
    // workspace, identity, email backfill, audit, membership
    expect(preview.statementCount).toBe(5);
    expect(counts(harness)).toEqual({ workspaces: 0, identities: 0, memberships: 0, audit: 0 });
  });

  it('apply writes exactly one workspace, identity, membership and audit row', async () => {
    const outcome = await applyFounderBootstrap(harness.db, INPUT);

    expect(outcome.status).toBe('CREATED');
    expect(counts(harness)).toEqual({ workspaces: 1, identities: 1, memberships: 1, audit: 1 });

    const workspace = harness.raw
      .prepare('SELECT id, name FROM workspaces WHERE id = ?')
      .get(WORKSPACE_ID) as { id: string; name: string };
    expect(workspace.name).toBe(WORKSPACE_NAME);

    const identity = harness.raw
      .prepare('SELECT id, access_sub, email FROM identities')
      .get() as { id: string; access_sub: string; email: string };
    expect(identity.id).toBe('id-pilot-founder');
    expect(identity.access_sub).toBe(SUBJECT);
    expect(identity.email).toBe(EMAIL);

    const membership = harness.raw
      .prepare('SELECT id, identity_id, workspace_id, role, granted_by, revoked_at FROM memberships')
      .get() as {
      id: string;
      identity_id: string;
      workspace_id: string;
      role: string;
      granted_by: string | null;
      revoked_at: string | null;
    };
    expect(membership).toEqual({
      id: 'mb-pilot-founder',
      identity_id: 'id-pilot-founder',
      workspace_id: WORKSPACE_ID,
      role: 'founder_admin',
      // Not the founder: the grant came from outside the application, and
      // recording the founder as her own granter would be a lie in the table the
      // product uses to prove who did what.
      granted_by: null,
      revoked_at: null,
    });

    const audit = harness.raw
      .prepare(
        'SELECT id, workspace_id, actor_id, actor_source, action, subject_type, subject_id, detail FROM audit_events',
      )
      .get() as {
      id: string;
      workspace_id: string;
      actor_id: string | null;
      actor_source: string;
      action: string;
      subject_type: string;
      subject_id: string;
      detail: string;
    };
    expect(audit.id).toBe('ae-pilot-bootstrap');
    expect(audit.workspace_id).toBe(WORKSPACE_ID);
    expect(audit.actor_id).toBeNull();
    expect(audit.actor_source).toBe('provisioning');
    expect(audit.action).toBe('membership.granted');
    expect(audit.subject_type).toBe('membership');
    expect(audit.subject_id).toBe('mb-pilot-founder');
    const detail = JSON.parse(audit.detail) as Record<string, unknown>;
    expect(detail.reason).toBe(INPUT.reason);
    expect(detail.access_subject).toBe(SUBJECT);
    expect(detail.environment).toBe('pilot');
    expect(detail.command).toBe('bootstrap:founder');
    // The actor is not authenticated, and the row says so rather than implying
    // otherwise: the operator reference is a declaration next to a timestamp.
    expect(detail.operator).toBe('ops:release-drill');
    expect(detail.ticket).toBe('CHG-2026-11-01');
    expect(detail.operator_reference).toBe('declared');
    expect(detail.subject_attestation).toBe('declared-not-verified');
  });

  it('the founder can then open the workspace, and only that workspace', async () => {
    await applyFounderBootstrap(harness.db, INPUT);
    setVerifier(verifierFor(SUBJECT, EMAIL));
    const env = pilotEnv(harness);

    const session = await worker.fetch(withToken(request('/api/session')), env, CTX);
    expect(session.status).toBe(200);
    const body = ((await session.json()) as {
      session: { role: string; workspaceId: string; workspaces?: { workspaceId: string; role: string; name: string }[] };
    }).session;
    expect(body.role).toBe('founder_admin');
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(body.workspaces).toEqual([
      { workspaceId: WORKSPACE_ID, role: 'founder_admin', name: WORKSPACE_NAME },
    ]);

    // Granted nothing anywhere else: a selector naming another workspace is
    // refused by the chokepoint, not answered with an empty list.
    const other = await worker.fetch(
      withToken(request('/api/orders', 'ws-somewhere-else')),
      env,
      CTX,
    );
    expect(other.status).toBe(403);
  });

  it('an identity with the same email but another subject gets nothing', async () => {
    await applyFounderBootstrap(harness.db, INPUT);

    // Someone else's token, labelled with the founder's email. The membership is
    // keyed on the subject, so the shared mailbox buys no access...
    setVerifier(verifierFor('access-sub-impostor-0002', EMAIL));
    const impostor = await worker.fetch(withToken(request('/api/session')), pilotEnv(harness), CTX);
    expect(impostor.status).toBe(403);

    // ...and the command refuses to create a second identity for that mailbox.
    const second = await applyFounderBootstrap(harness.db, {
      ...INPUT,
      accessSubject: 'access-sub-impostor-0002',
      ids: { identity: 'id-impostor', membership: 'mb-impostor', audit: 'ae-impostor' },
    });
    expect(second.status).toBe('REFUSED');
    if (second.status === 'REFUSED') expect(second.code).toBe('email_owned_by_another_subject');
    expect(counts(harness)).toEqual({ workspaces: 1, identities: 1, memberships: 1, audit: 1 });
  });

  it('a second run reports "already", and writes no duplicate membership or audit row', async () => {
    const first = await applyFounderBootstrap(harness.db, INPUT);
    expect(first.status).toBe('CREATED');
    const before = counts(harness);

    const second = await applyFounderBootstrap(harness.db, {
      ...INPUT,
      // Different generated ids would normally mean different rows; the decision
      // refuses before any statement is built.
      ids: undefined,
      timestamp: '2026-10-30T09:30:00.000Z',
    });

    expect(second.status).toBe('ALREADY');
    if (second.status === 'ALREADY') expect(second.membershipId).toBe('mb-pilot-founder');
    expect(counts(harness)).toEqual(before);
    const detail = harness.raw
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE actor_source = 'provisioning'")
      .get() as { n: number };
    expect(Number(detail.n)).toBe(1);
  });

  it('a revoked membership is not resurrected by a re-run', async () => {
    await applyFounderBootstrap(harness.db, INPUT);
    harness.raw
      .prepare('UPDATE memberships SET revoked_at = ? WHERE id = ?')
      .run('2026-10-30T10:00:00.000Z', 'mb-pilot-founder');

    const again = await applyFounderBootstrap(harness.db, {
      ...INPUT,
      ids: { identity: 'id-second', membership: 'mb-second', audit: 'ae-second' },
    });

    expect(again.status).toBe('REFUSED');
    if (again.status === 'REFUSED') expect(again.code).toBe('membership_revoked');
    const row = harness.raw
      .prepare('SELECT revoked_at FROM memberships WHERE id = ?')
      .get('mb-pilot-founder') as { revoked_at: string };
    expect(row.revoked_at).toBe('2026-10-30T10:00:00.000Z');
    expect(counts(harness).memberships).toBe(1);

    // And the revoked founder really is out: the next request is refused.
    setVerifier(verifierFor(SUBJECT, EMAIL));
    const session = await worker.fetch(withToken(request('/api/session')), pilotEnv(harness), CTX);
    expect(session.status).toBe(403);
  });

  it('refuses to change an existing role into founder_admin', async () => {
    harness.raw
      .prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(WORKSPACE_ID, WORKSPACE_NAME, TS, TS);
    harness.raw
      .prepare('INSERT INTO identities (id, access_sub, email, display_name, created_at) VALUES (?, ?, ?, NULL, ?)')
      .run('id-operator', SUBJECT, EMAIL, TS);
    harness.raw
      .prepare('INSERT INTO memberships (id, identity_id, workspace_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, NULL, ?)')
      .run('mb-operator', 'id-operator', WORKSPACE_ID, 'workspace_operator', TS);

    const outcome = await applyFounderBootstrap(harness.db, INPUT);

    expect(outcome.status).toBe('REFUSED');
    if (outcome.status === 'REFUSED') expect(outcome.code).toBe('role_conflict');
    const row = harness.raw
      .prepare('SELECT role FROM memberships WHERE id = ?')
      .get('mb-operator') as { role: string };
    expect(row.role).toBe('workspace_operator');
  });

  it('refuses a second founder when one is already live', async () => {
    await applyFounderBootstrap(harness.db, INPUT);

    const second = await applyFounderBootstrap(harness.db, {
      ...INPUT,
      workspaceId: 'ws-other',
      accessSubject: 'access-sub-second-0003',
      email: 'second@pilot.example.test',
      ids: { identity: 'id-second', membership: 'mb-second', audit: 'ae-second' },
    });

    expect(second.status).toBe('REFUSED');
    if (second.status === 'REFUSED') expect(second.code).toBe('founder_exists');
    expect(counts(harness)).toEqual({ workspaces: 1, identities: 1, memberships: 1, audit: 1 });
  });

  it('refuses a workspace id that exists under another name', async () => {
    harness.raw
      .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(WORKSPACE_ID, 'Tên khác', TS, TS);

    const outcome = await applyFounderBootstrap(harness.db, INPUT);

    expect(outcome.status).toBe('REFUSED');
    if (outcome.status === 'REFUSED') expect(outcome.code).toBe('workspace_name_conflict');
    expect(counts(harness).memberships).toBe(0);
  });

  it('two concurrent applies grant one founder, not two', async () => {
    const [first, second] = await Promise.all([
      applyFounderBootstrap(harness.db, INPUT),
      applyFounderBootstrap(harness.db, { ...INPUT, ids: undefined }),
    ]);

    const created = [first, second].filter((outcome) => outcome.status === 'CREATED');
    expect(created).toHaveLength(1);
    expect([first, second].filter((outcome) => outcome.status === 'CREATED')).not.toHaveLength(2);

    const founders = harness.raw
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE role = 'founder_admin' AND revoked_at IS NULL")
      .get() as { n: number };
    expect(Number(founders.n)).toBe(1);
    expect(counts(harness)).toEqual({ workspaces: 1, identities: 1, memberships: 1, audit: 1 });
  });

  it('two concurrent applies for different subjects still grant one founder', async () => {
    const [first, second] = await Promise.all([
      applyFounderBootstrap(harness.db, INPUT),
      applyFounderBootstrap(harness.db, {
        ...INPUT,
        accessSubject: 'access-sub-rival-0004',
        email: 'rival@pilot.example.test',
        ids: { identity: 'id-rival', membership: 'mb-rival', audit: 'ae-rival' },
      }),
    ]);

    expect([first, second].filter((outcome) => outcome.status === 'CREATED')).toHaveLength(1);
    const founders = harness.raw
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE role = 'founder_admin' AND revoked_at IS NULL")
      .get() as { n: number };
    expect(Number(founders.n)).toBe(1);
    expect(counts(harness).identities).toBeLessThanOrEqual(2);
  });

  it('a statement failing inside the batch rolls the whole batch back', async () => {
    // The audit insert is replaced with one that violates a CHECK, so the failure
    // lands after the workspace and identity inserts — the exact place a
    // non-transactional implementation would leave debris.
    const failing = {
      prepare: (sql: string) => harness.db.prepare(sql),
      batch: async (statements: unknown[]) => {
        const replaced = (statements as { sql: string }[]).map((statement) =>
          statement.sql.includes("'provisioning'")
            ? harness.db.prepare('INSERT INTO roles (role) VALUES (?)').bind('bootstrap-injected-failure')
            : statement,
        );
        return harness.db.batch(replaced as never[]);
      },
    };

    await expect(applyFounderBootstrap(failing as never, INPUT)).rejects.toThrow();

    expect(counts(harness)).toEqual({ workspaces: 0, identities: 0, memberships: 0, audit: 0 });
  });

  it('rejects input that could split a statement in the generated SQL file', async () => {
    const problems = validateBootstrapInput({
      ...INPUT,
      reason: "pilot'; DROP TABLE memberships; --",
    });
    expect(problems.map((p) => p.field)).toContain('reason');
    expect(problems.some((p) => p.message.includes('semicolon'))).toBe(true);

    const outcome = await applyFounderBootstrap(harness.db, { ...INPUT, reason: 'a; b -- c' });
    expect(outcome.status).toBe('REFUSED');
    expect(counts(harness)).toEqual({ workspaces: 0, identities: 0, memberships: 0, audit: 0 });
  });

  it('requires an operator reference, and stores a ticket only when given', async () => {
    const missingOperator = validateBootstrapInput({ ...INPUT, operator: '   ' });
    expect(missingOperator.map((p) => p.field)).toContain('operator');

    const refused = await applyFounderBootstrap(harness.db, { ...INPUT, operator: '' });
    expect(refused.status).toBe('REFUSED');
    if (refused.status === 'REFUSED') expect(refused.code).toBe('invalid_input');
    expect(counts(harness)).toEqual({ workspaces: 0, identities: 0, memberships: 0, audit: 0 });

    const noTicket = await applyFounderBootstrap(harness.db, { ...INPUT, ticket: '' });
    expect(noTicket.status).toBe('CREATED');
    const detail = JSON.parse(
      (
        harness.raw.prepare('SELECT detail FROM audit_events WHERE id = ?').get('ae-pilot-bootstrap') as {
          detail: string;
        }
      ).detail,
    ) as Record<string, unknown>;
    expect(detail.ticket).toBeNull();
    expect(detail.operator).toBe('ops:release-drill');
  });

  it('handles quotes, Vietnamese text and a reason at the length limit', async () => {
    const longReason = 'Lý do cấp quyền: '.repeat(24).slice(0, 500);
    const input: FounderBootstrapInput = {
      ...INPUT,
      workspaceName: `Vườn O'Brien — "Pilot" (chi nhánh 2)`,
      reason: `${longReason} — O'Brien`,
      operator: "ops:Nguyễn Văn A — 'release'",
      ticket: 'CHG/"quoted"/001',
      ids: { identity: 'id-quotes', membership: 'mb-quotes', audit: 'ae-quotes' },
    };
    expect(validateBootstrapInput(input)).toEqual([]);

    const outcome = await applyFounderBootstrap(harness.db, input);
    expect(outcome.status).toBe('CREATED');

    const row = harness.raw
      .prepare(
        `SELECT w.name AS name, a.detail AS detail
           FROM workspaces w JOIN audit_events a ON a.workspace_id = w.id`,
      )
      .get() as { name: string; detail: string };
    expect(row.name).toBe(input.workspaceName);
    const detail = JSON.parse(row.detail) as Record<string, unknown>;
    expect(detail.reason).toBe(input.reason);
    expect(detail.operator).toBe(input.operator);
    expect(detail.ticket).toBe(input.ticket);
  });

  it('rejects a malformed workspace id and a subject that is missing', () => {
    const problems = validateBootstrapInput({ ...INPUT, workspaceId: 'WS Pilot!', accessSubject: '  ' });
    expect(problems.map((p) => p.field)).toEqual(expect.arrayContaining(['workspaceId', 'accessSubject']));
  });

  it('the decision is a pure function of the state it is given', async () => {
    const state = await readBootstrapState(harness.db, INPUT);
    const first = decideFounderBootstrap(state, INPUT);
    const second = decideFounderBootstrap(state, INPUT);
    expect(first).toEqual(second);
    expect(first.kind).toBe('create');
  });
});

describe('the generated SQL file matches the parameterized path', () => {
  it('round-trips Vietnamese text, quotes and a 500-character reason through the file path', async () => {
    const quoted = createSqliteD1({ seedDemo: false });
    const input: FounderBootstrapInput = {
      ...INPUT,
      workspaceName: `Vườn "Út" O'Brien — Đồng Tháp`,
      reason: `Cấp quyền founder cho pilot: ${'lý do '.repeat(70)}`.slice(0, 400),
      operator: "ops:Trần 'B'",
      ticket: 'CHG-001/"A"',
      ids: { identity: 'id-q', membership: 'mb-q', audit: 'ae-q' },
    };
    expect(validateBootstrapInput(input)).toEqual([]);

    // The CLI file path — the only route that cannot bind parameters.
    const statements = bootstrapStatements(input, { createWorkspace: true, createIdentity: true });
    const script = renderSqlScript(statements);
    expect(script).not.toContain('\u0000');
    quoted.raw.exec('BEGIN IMMEDIATE;');
    for (const statement of script.split(/;\n\n/)) {
      const trimmed = statement.trim().replace(/;$/, '');
      if (trimmed !== '') quoted.raw.exec(trimmed);
    }
    quoted.raw.exec('COMMIT;');

    const row = quoted.raw
      .prepare('SELECT w.name AS name, i.email AS email, a.detail AS detail FROM workspaces w JOIN identities i ON 1=1 JOIN audit_events a ON 1=1')
      .get() as { name: string; email: string; detail: string };
    expect(row.name).toBe(input.workspaceName);
    expect(row.email).toBe(input.email);
    const detail = JSON.parse(row.detail) as Record<string, unknown>;
    expect(detail.reason).toBe(input.reason);
    expect(detail.operator).toBe(input.operator);
  });

  it('renders the same rows as bound statements, quotes and all', async () => {
    const parameterised = createSqliteD1({ seedDemo: false });
    const rendered = createSqliteD1({ seedDemo: false });

    const input: FounderBootstrapInput = {
      ...INPUT,
      workspaceName: "Vườn O'Brien — pilot",
      reason: "Pilot: founder's first grant",
      ids: { identity: 'id-a', membership: 'mb-a', audit: 'ae-a' },
    };

    const bound = await applyFounderBootstrap(parameterised.db, input);
    expect(bound.status).toBe('CREATED');

    // The CLI path: no bindings, one script, executed statement by statement in a
    // transaction — exactly what `wrangler d1 execute --file` does.
    const statements = bootstrapStatements(input, { createWorkspace: true, createIdentity: true });
    const script = renderSqlScript(statements);
    rendered.raw.exec('BEGIN IMMEDIATE;');
    for (const statement of script.split(/;\n\n/)) {
      const trimmed = statement.trim().replace(/;$/, '');
      if (trimmed !== '') rendered.raw.exec(trimmed);
    }
    rendered.raw.exec('COMMIT;');

    const read = (harness: Harness) =>
      harness.raw
        .prepare(
          `SELECT w.name AS workspace_name, i.access_sub, i.email, m.role, a.detail, a.actor_source
             FROM memberships m
             JOIN workspaces w ON w.id = m.workspace_id
             JOIN identities i ON i.id = m.identity_id
             JOIN audit_events a ON a.subject_id = m.id`,
        )
        .get();
    expect(read(rendered)).toEqual(read(parameterised));
  });

  it('sqlLiteral quotes strings, passes numbers, and refuses what it cannot write', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral(30)).toBe('30');
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
    expect(() => sqlLiteral(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => sqlLiteral({ a: 1 })).toThrow(/Refusing/);
    expect(() => sqlLiteral('a\u0000b')).toThrow(/NUL/);
  });
});

describe('the environment guard owns the command', () => {
  function fakeProcess(argv: string[]): ProcessPort & { messages: string[]; code: number | null } {
    const messages: string[] = [];
    const fake = {
      argv,
      code: null as number | null,
      messages,
      exit(code: number): never {
        fake.code = code;
        throw new Error(`exit ${code}`);
      },
      stderr: {
        write(chunk: string): boolean {
          messages.push(chunk);
          return true;
        },
      },
      stdout: {
        write(chunk: string): boolean {
          messages.push(chunk);
          return true;
        },
      },
    };
    return fake;
  }

  it('is declared for test and pilot, and for nothing else', () => {
    expect(COMMAND_ENVIRONMENTS['bootstrap:founder']).toEqual(['test', 'pilot']);
  });

  it('refuses demo, and refuses to run without an environment', () => {
    for (const argv of [
      ['node', 'script', '--env', 'demo'],
      ['node', 'script', '--env', 'production'],
      ['node', 'script'],
    ]) {
      const proc = fakeProcess(argv);
      expect(() => requireEnvironment(proc, 'bootstrap:founder')).toThrow();
      expect(proc.code).toBe(2);
    }
  });

  it('the script itself refuses demo, before it touches a database', () => {
    // A subprocess, because the claim is about the file an operator runs, not
    // about the helper it imports. The guard exits before any wrangler call, so
    // this costs milliseconds and cannot write.
    const result = spawnSync(
      process.execPath,
      [
        'scripts/bootstrap-founder.ts',
        '--env',
        'demo',
        '--workspace-id',
        'ws-x',
        '--workspace-name',
        'X',
        '--access-sub',
        'sub',
        '--email',
        'a@b.co',
        '--reason',
        'should never run here',
        '--operator',
        'ops:test',
      ],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not accept the "demo" environment');
    expect(result.stdout).not.toContain('Executing');
  });

  it('the script refuses --apply without the subject attestation', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/bootstrap-founder.ts',
        '--env',
        'test',
        '--workspace-id',
        'ws-x',
        '--workspace-name',
        'X',
        '--access-sub',
        'sub',
        '--email',
        'a@b.co',
        '--reason',
        'should never run here either',
        '--operator',
        'ops:test',
        '--apply',
      ],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--subject-verified');
  });

  it('the script refuses an apply with no --operator, before it touches a database', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/bootstrap-founder.ts',
        '--env',
        'test',
        '--workspace-id',
        'ws-x',
        '--workspace-name',
        'X',
        '--access-sub',
        'sub',
        '--email',
        'a@b.co',
        '--reason',
        'no operator reference given',
        '--apply',
        '--subject-verified',
      ],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('operator');
    expect(result.stdout).not.toContain('Executing');
  });

  it('never echoes the Access configuration, even when it is in the environment', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/bootstrap-founder.ts',
        '--env',
        'demo',
        '--workspace-id',
        'ws-x',
        '--workspace-name',
        'X',
        '--access-sub',
        'sub',
        '--email',
        'a@b.co',
        '--reason',
        'credential echo check',
        '--operator',
        'ops:test',
      ],
      {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        env: {
          ...process.env,
          ACCESS_AUD: 'aud-sentinel-value-1234567890',
          ACCESS_TEAM_DOMAIN: 'team-sentinel.example.test',
          CLOUDFLARE_API_TOKEN: 'cf-token-sentinel-0987654321',
        },
      },
    );
    const printed = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(printed).not.toContain('aud-sentinel-value-1234567890');
    expect(printed).not.toContain('team-sentinel.example.test');
    expect(printed).not.toContain('cf-token-sentinel-0987654321');
  });

  it('a command the guard does not declare accepts no environment at all', () => {
    for (const name of ['bootstrap:anything', 'bootstrap:founder ', '']) {
      const proc = fakeProcess(['node', 'script', '--env', 'pilot']);
      expect(() => requireEnvironment(proc, name)).toThrow();
      expect(proc.code).toBe(2);
    }
  });
});

describe('HTTP cannot reach the bootstrap', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = createSqliteD1({ seedDemo: false });
    setMembershipStore(null);
    setVerifier(verifierFor(SUBJECT, EMAIL));
  });

  afterEach(() => {
    setVerifier(null);
  });

  it('answers 404 to every bootstrap-shaped path, and writes nothing', async () => {
    const paths = [
      '/api/bootstrap',
      '/api/bootstrap/founder',
      '/api/founder/bootstrap',
      '/api/admin/bootstrap',
      '/api/memberships/grant',
      '/api/setup',
    ];

    for (const path of paths) {
      for (const method of ['GET', 'POST']) {
        const response = await worker.fetch(
          withToken(request(path, undefined, { method, headers: { 'Sec-Fetch-Site': 'same-origin' } })),
          pilotEnv(harness),
          CTX,
        );
        expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 404`);
      }
    }

    expect(counts(harness)).toEqual({ workspaces: 0, identities: 0, memberships: 0, audit: 0 });
  });

  it('the Worker module does not import the bootstrap, so the bundle cannot expose it', () => {
    const workerSource = readFileSync(new URL('../src/worker/index.ts', import.meta.url), 'utf8');
    expect(workerSource).not.toContain('founder-bootstrap');
    const routes = readFileSync(new URL('../src/worker/index.ts', import.meta.url), 'utf8');
    expect(routes).not.toMatch(/bootstrap/i);
  });
});

describe('authentication is not weakened by any of this', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createSqliteD1({ seedDemo: false });
    setMembershipStore(null);
  });

  afterEach(() => {
    setVerifier(null);
  });

  it('a missing token is 401 on pilot', async () => {
    setVerifier(verifierFor(SUBJECT, EMAIL));
    const response = await worker.fetch(request('/api/session'), pilotEnv(harness), CTX);
    expect(response.status).toBe(401);
  });

  it('a token the verifier rejects is 401, even after a bootstrap', async () => {
    await applyFounderBootstrap(harness.db, INPUT);
    // The verifier refuses every token: this is a forged or expired assertion.
    setVerifier(async () => null);
    const response = await worker.fetch(
      withToken(request('/api/session'), 'forged.token.value'),
      pilotEnv(harness),
      CTX,
    );
    expect(response.status).toBe(401);
  });

  it('a dev identity cannot be selected on a pilot deployment', async () => {
    await applyFounderBootstrap(harness.db, INPUT);
    setVerifier(verifierFor(SUBJECT, EMAIL));
    const env = { ...pilotEnv(harness), DEV_IDENTITY: 'admin', DEV_IDENTITY_SUBJECT: SUBJECT };
    const response = await worker.fetch(request('/api/session'), env, CTX);
    // No token, and the dev adapter is inert outside local/test, so there is no
    // identity to resolve — the demo path cannot be used to walk in.
    expect(response.status).toBe(401);
  });

  it('the dev probe is not registered on pilot', async () => {
    setVerifier(verifierFor(SUBJECT, EMAIL));
    const response = await worker.fetch(withToken(request('/api/whoami')), pilotEnv(harness), CTX);
    expect(response.status).toBe(404);
  });

  it('the demo seed still cannot be pointed at pilot', () => {
    expect(COMMAND_ENVIRONMENTS['db:seed:demo']).toEqual(['demo']);
  });
});

describe('the deploy contract asks only for what a deploy uses', () => {
  it('requires the two Access values', () => {
    expect(missingDeployConfiguration({})).toEqual(['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']);
    expect(missingDeployConfiguration({ ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com' })).toEqual([
      'ACCESS_AUD',
    ]);
    expect(missingDeployConfiguration({ ACCESS_TEAM_DOMAIN: '  ', ACCESS_AUD: 'aud' })).toEqual([
      'ACCESS_TEAM_DOMAIN',
    ]);
    expect(
      missingDeployConfiguration({ ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud' }),
    ).toEqual([]);
  });

  it('a founder value is not a deploy input, because deploying grants nothing', async () => {
    const harness = createSqliteD1({ seedDemo: false });
    // The environment has both Access values and no FOUNDER_* — the state a
    // deployment is in now. Access still refuses, and no membership exists.
    const env = { APP_ENV: 'pilot', sadec_pilot: harness.db, ACCESS_TEAM_DOMAIN: 'd', ACCESS_AUD: 'a' };
    setMembershipStore(null);
    setVerifier(async () => null);
    const response = await worker.fetch(request('/api/session'), env, CTX);
    expect(response.status).toBe(401);
    expect(counts(harness)).toEqual({ workspaces: 0, identities: 0, memberships: 0, audit: 0 });
    setVerifier(null);
  });
});
