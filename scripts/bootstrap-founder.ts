#!/usr/bin/env node
/**
 * Grants the first `founder_admin`, outside the HTTP surface.
 *
 * This is the only way into an empty database. It is deliberately a command an
 * operator runs at a terminal, not an endpoint, not a Worker start-up hook and
 * not a "first person to log in" rule: §6 forbids all three, and the pilot needs
 * exactly one founder before anyone can use the app at all.
 *
 *   pnpm bootstrap:founder -- --env pilot \
 *     --workspace-id ws-pilot --workspace-name "Vườn pilot" \
 *     --access-sub <the subject from a verified Access identity> \
 *     --email founder@example.com \
 *     --reason "Pilot 2026-11: first founder" \
 *     --operator "ops:nguyen" --ticket "CHG-2026-11-01"
 *
 * Preview is the default and writes nothing. `--apply` writes, and also requires
 * `--subject-verified`, an explicit statement that the operator read the subject
 * from the identity rather than copying the email into the field.
 *
 * The command is a shell around `src/ops/founder-bootstrap.ts`, which holds the
 * decision rules and the SQL. This file adds the two things a library cannot: the
 * environment guard shared by every database command, and the transport to the
 * database (`wrangler d1 execute`), which is the same transport `db:seed:demo`
 * and `db:migrate-pilot` use.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyFounderBootstrap,
  previewFounderBootstrap,
  renderSqlScript,
  sqlLiteral,
  validateBootstrapInput,
  type BootstrapOutcome,
  type BootstrapPreview,
  type BootstrapState,
  type FounderBootstrapInput,
  type SqlStatement,
} from '../src/ops/founder-bootstrap.ts';
import type { D1Like } from '../src/ops/catalog.ts';
import {
  bindingNameFor,
  persistArguments,
  printTarget,
  requireEnvironment,
  type Environment,
} from './require-environment.ts';

const environment = requireEnvironment(process, 'bootstrap:founder');
const binding = bindingNameFor(environment);
const apply = process.argv.includes('--apply');
const subjectVerified = process.argv.includes('--subject-verified');
const remote = environment === 'pilot';

printTarget(process, {
  command: 'bootstrap:founder',
  environment,
  database: binding,
  extra: [
    remote ? 'Target is the REMOTE database (--remote).' : 'Target is the LOCAL database (--local).',
    apply ? 'Mode: APPLY — this will write rows.' : 'Mode: preview (default) — nothing is written.',
    'Deploying the Worker does not create a membership; this command does.',
  ],
});

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

const input: FounderBootstrapInput = {
  environment,
  workspaceId: flag('--workspace-id') ?? '',
  workspaceName: flag('--workspace-name') ?? '',
  accessSubject: flag('--access-sub') ?? '',
  email: flag('--email') ?? '',
  reason: flag('--reason') ?? '',
  operator: flag('--operator') ?? '',
  ticket: flag('--ticket') ?? '',
};

function usage(message: string): never {
  process.stderr.write(
    `\nError: ${message}\n\n` +
      'Usage:\n' +
      '  pnpm bootstrap:founder -- --env <test|pilot> \\\n' +
      '    --workspace-id <id> --workspace-name "<name>" \\\n' +
      '    --access-sub <Access subject> --email <email> --reason "<why>" \\\n' +
      '    --operator "<who is running this>" [--ticket "<change or ticket>"] \\\n' +
      '    [--apply --subject-verified]\n\n' +
      'Preview is the default. Nothing is written without --apply.\n' +
      'The subject must be read from a verified identity; it is never derived from\n' +
      'the email, and the command cannot verify it for you.\n\n' +
      '--operator and --ticket are recorded in the audit row as declarations. They are\n' +
      'not authenticated: this command runs outside the application, so nothing here\n' +
      'can prove who ran it. Their value is that they sit next to a timestamp and a\n' +
      'database name, where an infrastructure log can confirm them.\n',
  );
  process.exit(2);
}

const problems = validateBootstrapInput(input);
if (problems.length > 0) {
  process.stderr.write('\nRefusing: the input is incomplete or malformed.\n');
  for (const problem of problems) process.stderr.write(`  - ${problem.field} ${problem.message}\n`);
  process.stderr.write('\n');
  process.exit(2);
}

if (apply && !subjectVerified) {
  usage(
    '--apply requires --subject-verified.\n' +
      'Pass it only after reading the subject from the identity Access verified (the\n' +
      '`sub` claim), not after copying the email into --access-sub.',
  );
}

if (input.accessSubject.trim().toLowerCase() === input.email.trim().toLowerCase()) {
  process.stderr.write(
    '\nWarning: --access-sub is identical to --email.\n' +
      'That is correct for some identity providers (Cloudflare One-time PIN uses the\n' +
      'email as the subject) and wrong if the email was copied into the field. Access\n' +
      'verification keys on the subject, so a wrong subject creates an identity nobody\n' +
      'can sign in as, and a second bootstrap would then be refused.\n\n',
  );
}

// ---------------------------------------------------------------------------
// Transport: wrangler d1 execute
// ---------------------------------------------------------------------------

const WRANGLER_ARGS = remote ? ['--remote'] : ['--local', ...persistArguments()];

/**
 * A failure reaching or inside the database, tagged with the phase it happened in.
 *
 * The distinction is the difference between "nothing was written, run the preview
 * again" and "the write may have committed, read the rows before you touch
 * anything". Two concurrent invocations against one local database can produce a
 * transport-level error (Miniflare opening the same file from two processes), and
 * conflating that with a policy refusal would teach an operator to retry a
 * command whose effect they have not checked.
 */
class TransportError extends Error {
  readonly phase: 'read' | 'write';
  constructor(phase: 'read' | 'write', message: string) {
    super(message);
    this.phase = phase;
  }
}

/**
 * Runs one statement and returns the rows.
 *
 * `--json` is parsed from the first line that starts a JSON array, because
 * wrangler also prints a banner to stdout. The parse is checked rather than
 * assumed: an unparseable response is a failure, not an empty result — an empty
 * result would read as "nothing exists yet", which is the one wrong answer this
 * command must never invent.
 */
function runStatement(sql: string): Record<string, unknown>[] {
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', binding, ...WRANGLER_ARGS, '--json', '--command', sql],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new TransportError(
      'read',
      `the database could not be read (wrangler exit ${result.status}).\n${result.stderr ?? ''}${
        result.stdout ?? ''
      }`,
    );
  }

  const stdout = result.stdout ?? '';
  const start = stdout.search(/^\[/m);
  if (start === -1) {
    throw new TransportError('read', `wrangler returned no JSON array:\n${stdout}\n${result.stderr ?? ''}`);
  }
  const parsed: unknown = JSON.parse(stdout.slice(start));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TransportError('read', `wrangler returned an unexpected JSON shape:\n${stdout}`);
  }
  const first = parsed[0] as { results?: unknown; success?: boolean };
  if (first.success === false) {
    throw new TransportError(
      'read',
      `the statement failed inside D1:\n${JSON.stringify(first, null, 2)}`,
    );
  }
  return Array.isArray(first.results) ? (first.results as Record<string, unknown>[]) : [];
}

/**
 * D1 as this command needs it: prepared statements, and a batch written as one SQL
 * file.
 *
 * The batch is the atomicity boundary, and what that means was measured instead of
 * assumed: a local file whose last statement violates a CHECK left `workspaces`,
 * `identities`, `memberships` and `audit_events` at zero, and the same file without
 * the bad statement wrote all four rows (`test/bootstrap-transport.test.ts`). The
 * remote endpoint's handling of a `--file` script has **not** been observed, which
 * is why remote atomicity is a separate procedure on a throwaway database, and why
 * an exit 1 has its own read-back instructions: a happy-path apply cannot tell you
 * what a failure would have done.
 *
 * The file is written with 0600 in a private temporary directory and removed in a
 * `finally`, so a refused or failed run leaves no statements lying around.
 */
function wranglerDatabase(): D1Like {
  return {
    prepare(sql: string) {
      const state: { sql: string; params: unknown[] } = { sql, params: [] };
      // `sql` and `params` are carded on the statement as well as closed over, so
      // the batch path can serialize it without a second registry of statements.
      const statement = {
        get sql(): string {
          return state.sql;
        },
        get params(): readonly unknown[] {
          return state.params;
        },
        bind(...values: unknown[]) {
          state.params = values;
          return statement;
        },
        async first<T = Record<string, unknown>>(): Promise<T | null> {
          const rows = runStatement(inline(state.sql, state.params));
          return (rows[0] as T | undefined) ?? null;
        },
        async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          return { results: runStatement(inline(state.sql, state.params)) as T[] };
        },
        async run(): Promise<{ meta: { changes: number } }> {
          runStatement(inline(state.sql, state.params));
          return { meta: { changes: 0 } };
        },
      };
      return statement as never;
    },
    async batch(statements: unknown[]): Promise<unknown> {
      const script = renderSqlScript((statements as SqlStatement[]).map(toStatement));
      const directory = mkdtempSync(join(tmpdir(), 'sadec-bootstrap-'));
      const file = join(directory, 'bootstrap.sql');
      try {
        writeFileSync(file, `${script}\n`, { mode: 0o600 });
        const result = spawnSync(
          'pnpm',
          ['exec', 'wrangler', 'd1', 'execute', binding, ...WRANGLER_ARGS, '--file', file],
          { encoding: 'utf8' },
        );
        if (result.status !== 0) {
          throw new TransportError(
            'write',
            `the write failed (exit ${result.status}).\n` +
              `${result.stdout ?? ''}${result.stderr ?? ''}`,
          );
        }
        return [];
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

/** The statements handed to `batch` carry their own text and parameters. */
function toStatement(value: unknown): SqlStatement {
  const candidate = value as { sql?: unknown; params?: unknown };
  if (typeof candidate?.sql !== 'string') {
    throw new Error('batch() received a statement that was not built by this command');
  }
  return { sql: candidate.sql, params: Array.isArray(candidate.params) ? candidate.params : [] };
}

/** Binds a statement's parameters into its text, for the CLI transport only. */
function inline(sql: string, params: readonly unknown[]): string {
  let index = 0;
  const text = sql.replace(/\?/g, () => sqlLiteral(params[index++]));
  if (index !== params.length) {
    throw new Error(`statement used ${index} parameters but ${params.length} were bound:\n${sql}`);
  }
  return text;
}

const database = wranglerDatabase();

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function summariseState(state: BootstrapState): string {
  const lines: string[] = [];
  lines.push(
    `Workspace "${input.workspaceId}": ${
      state.workspace === null ? 'does not exist (would be created)' : `exists as "${state.workspace.name}"`
    }`,
  );
  lines.push(
    `Identity for the subject: ${
      state.identity === null
        ? 'does not exist (would be created)'
        : `exists as ${state.identity.id} (email ${state.identity.email ?? 'not recorded'})`
    }`,
  );
  if (state.emailHolders.length > 0) {
    lines.push(
      `Identities already holding this email: ${state.emailHolders
        .map((row) => `${row.id} (${row.accessSub})`)
        .join(', ')}`,
    );
  }
  lines.push(
    `Memberships for this subject in this workspace: ${
      state.pairMemberships.length === 0
        ? 'none'
        : state.pairMemberships
            .map((row) => `${row.role} (${row.id})${row.revokedAt === null ? '' : ` revoked ${row.revokedAt}`}`)
            .join(', ')
    }`,
  );
  lines.push(
    `Live founders in this database: ${
      state.activeFounders.length === 0
        ? 'none'
        : state.activeFounders
            .map((row) => `${row.accessSubject} in ${row.workspaceId}`)
            .join(', ')
    }`,
  );
  return lines.join('\n');
}

function printPreview(preview: BootstrapPreview): void {
  process.stdout.write(`\n${summariseState(preview.state)}\n\n`);
  process.stdout.write(
    `Operator:    ${input.operator.trim()} (declared, not authenticated)\n` +
      `Ticket:      ${(input.ticket ?? '').trim() === '' ? '(none given)' : (input.ticket ?? '').trim()}\n\n`,
  );
  if (preview.decision.kind === 'create') {
    process.stdout.write(
      'Would write, in one transaction:\n' +
        `  1. workspace ${input.workspaceId}${
          preview.decision.createWorkspace ? '' : ' (exists, not recreated)'
        }\n` +
        `  2. identity for the subject${
          preview.decision.createIdentity ? '' : ' (exists, email filled only if empty)'
        }\n` +
        '  3. audit row: action membership.granted, actor_source provisioning, actor_id NULL\n' +
        '  4. membership: role founder_admin, granted_by NULL, revoked_at NULL\n' +
        'The audit row is written before the membership and gates it: an operation\n' +
        'that cannot record what it did does not happen.\n',
    );
  } else if (preview.decision.kind === 'already') {
    process.stdout.write(
      `Nothing to do: the subject already holds a live founder_admin membership (${preview.decision.membershipId}).\n`,
    );
  } else {
    process.stdout.write(`Refused: ${preview.decision.message}\n`);
  }
}

async function main(): Promise<void> {
  if (!apply) {
    const preview = await previewFounderBootstrap(database, input);
    printPreview(preview);
    if (preview.status === 'REFUSED') {
      process.exit(3);
    }
    process.stdout.write('\nNothing was written. Re-run with --apply --subject-verified to write.\n');
    return;
  }

  const outcome: BootstrapOutcome = await applyFounderBootstrap(database, input);

  switch (outcome.status) {
    case 'CREATED':
      process.stdout.write(
        '\nCreated in one transaction:\n' +
          `  workspace  ${outcome.created.workspace.id} "${outcome.created.workspace.name}"${
            outcome.created.workspace.created ? '' : ' (already existed)'
          }\n` +
          `  identity   ${outcome.created.identity.id} <${outcome.created.identity.email}>${
            outcome.created.identity.created ? '' : ' (already existed)'
          }\n` +
          `  membership ${outcome.created.membership.id} role ${outcome.created.membership.role}\n` +
          `  audit      ${outcome.created.auditEventId} (actor_source provisioning,\n` +
          `             operator "${input.operator.trim()}" recorded as declared)\n\n` +
          'Next: sign in through Access as this identity and check /api/session reports\n' +
          'founder_admin. Signing in does not grant anything — this command did.\n',
      );
      return;
    case 'ALREADY':
      process.stdout.write(`\n${outcome.message}\n`);
      return;
    case 'REFUSED':
      process.stderr.write(`\nRefused (${outcome.code}): ${outcome.message}\n`);
      process.exit(3);
      return;
    case 'NOT_WRITTEN':
      process.stderr.write(`\n${outcome.message}\n\n${summariseState(outcome.state)}\n`);
      process.exit(4);
      return;
    case 'INCONSISTENT':
      process.stderr.write(`\n${outcome.message}\n\n${summariseState(outcome.state)}\n`);
      process.stderr.write(
        '\nDo not re-run blindly. Read the rows above, and check the audit row and the\n' +
          'membership before deciding what to do.\n',
      );
      process.exit(1);
      return;
  }
}

main().catch((error: unknown) => {
  if (error instanceof TransportError) {
    process.stderr.write(`\nbootstrap:founder could not complete: ${error.message}\n\n`);
    if (error.phase === 'read') {
      process.stderr.write(
        'Nothing was written: the command could not read the database, so it never\n' +
          'built the write. If another bootstrap is running against this database, wait\n' +
          'for it and run the preview again. Do not retry until you can read the state.\n',
      );
      process.exit(4);
    }
    // Not "rolled back by D1": the script is sent as one transaction, and a
    // local failing-file test showed the whole batch disappearing, but a
    // transport failure at this point does not say *where* it failed. Claiming
    // a rollback would be inferring an outcome from semantics instead of
    // reading the database, which is the mistake this command exists to avoid.
    process.stderr.write(
      'The write failed, and this process cannot tell from the failure whether the\n' +
        'batch landed. Do not re-run and do not retry: run the preview again and read\n' +
        'the rows it prints. If they show a founder, the batch committed; if they show\n' +
        'none, it did not.\n',
    );
    process.exit(1);
  }
  process.stderr.write(`\nbootstrap:founder failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
