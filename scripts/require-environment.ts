/**
 * Resolves and validates the target environment for every command that touches
 * a database. §14 requires each command to name its environment, print the
 * target, and refuse when the target is missing or the wrong kind — never fall
 * back silently to another database.
 *
 * The reason this is one shared helper rather than a check inside each script: a
 * restore that lands on the wrong database destroys the evidence it was meant to
 * prove, and a per-script check can be forgotten in exactly one script.
 */

/**
 * The three data environments, kept deliberately separate. §6 and §14 require
 * demo, test and pilot to be independent, so a test never runs against the
 * database a demo depends on, and pilot never inherits sample data.
 */
export type Environment = 'demo' | 'test' | 'pilot';

export const ENVIRONMENTS: readonly Environment[] = ['demo', 'test', 'pilot'];

/**
 * Which environments each command may name. A restore targets only the test
 * database, so naming pilot is refused rather than silently restoring over
 * pilot data.
 */
export const COMMAND_ENVIRONMENTS: Readonly<Record<string, readonly Environment[]>> = {
  'db:migrate:local': ['demo', 'test'],
  'db:seed:demo': ['demo'],
  'db:backup': ['demo', 'test', 'pilot'],
  'db:restore:test': ['test'],
  'db:migrate-pilot': ['pilot'],
  'deploy:preview': ['pilot'],
  // The first founder is provisioned outside the HTTP surface. Pilot is the real
  // target; test is the local database used to prove the command before it is
  // pointed at anything real. Demo is refused because demo data is seeded, not
  // provisioned, and a bootstrap row in the demo database would make the seeded
  // founder ambiguous.
  'bootstrap:founder': ['test', 'pilot'],
};

const USAGE =
  'Usage: pnpm <command> -- --env <demo|test|pilot>\n' +
  'The environment is required, and the target database name is printed before anything runs.';

/**
 * Parses an explicit `--env <name>`.
 *
 * Returns null when the flag is absent, so a caller tells "the operator did not
 * say" apart from "the operator said something invalid".
 */
export function parseEnvironmentFlag(argv: readonly string[]): string | null {
  const index = argv.indexOf('--env');
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * The only three members of the Node process this file uses. Declaring a narrow
 * surface means a test can supply a stand-in, and a future change cannot quietly
 * start depending on more of the process than was written down.
 */
export interface ProcessPort {
  readonly argv: readonly string[];
  exit(code: number): never;
  stderr: { write(chunk: string): boolean };
  stdout: { write(chunk: string): boolean };
}

/**
 * Resolves the environment for a command, exiting with a readable message when
 * it is missing or not permitted.
 *
 * Exits rather than throwing, because these are operator-facing scripts and the
 * message has to be useful at the exact point of failure.
 */
export function requireEnvironment(
  proc: ProcessPort,
  commandName: string,
): Environment {
  // An unlisted command accepts nothing. Falling back to "every environment" is
  // the wrong default for scripts that touch databases: the one command whose key
  // is missing would then run against any target named, including pilot.
  const allowed = COMMAND_ENVIRONMENTS[commandName] ?? [];
  const requested = parseEnvironmentFlag(proc.argv.slice(2));

  if (requested === null) {
    proc.stderr.write(
      `Error: ${commandName} requires an explicit environment.\n${USAGE}\n`,
    );
    proc.exit(2);
  }

  if (!isEnvironment(requested) || !allowed.includes(requested)) {
    proc.stderr.write(
      `Error: ${commandName} does not accept the "${requested}" environment.\n` +
        `Accepted: ${allowed.join(', ')} for this command.\n`,
    );
    proc.exit(2);
  }

  return requested;
}

/** The binding name for an environment, written once so names cannot drift. */
export function bindingNameFor(environment: Environment): string {
  return `sadec_${environment}`;
}

/**
 * Prints the target before any work happens. §14 requires the target to be
 * visible rather than secret, so an operator can see what they are about to hit.
 */
export function printTarget(
  proc: ProcessPort,
  target: {
    command: string;
    environment: string;
    database: string;
    extra?: readonly string[];
  },
): void {
  const lines = [
    `Command:     ${target.command}`,
    `Environment: ${target.environment}`,
    `Database:    ${target.database}`,
  ];
  if (target.extra) lines.push(...target.extra);
  proc.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * The local persistence directory, when a caller asks for a different one.
 *
 * `wrangler --persist-to` decides which local database file a command touches,
 * and the browser suite needs its own so resetting it cannot erase a
 * developer's working data. The value comes from `SADEC_D1_PERSIST` — set by
 * `playwright.config.ts` for the two suite servers and by
 * `scripts/e2e-prepare.ts` for the migrate and seed commands — and is never
 * inferred: with the variable unset every command keeps the default
 * `.wrangler/state` it has always used.
 *
 * It is validated rather than passed through, because it is a path a command
 * will delete from: an empty string, a parent directory or an absolute path
 * outside the repository is refused.
 */
export function persistPathFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = environment.SADEC_D1_PERSIST?.trim();
  if (raw === undefined || raw === '') return null;
  if (raw.startsWith('/') || raw.startsWith('..') || raw.includes('..')) {
    throw new Error(
      `SADEC_D1_PERSIST must be a directory inside the repository, got "${raw}".`,
    );
  }
  if (!raw.startsWith('.wrangler/')) {
    throw new Error(
      `SADEC_D1_PERSIST must live under .wrangler/ so it stays out of git, got "${raw}".`,
    );
  }
  return raw;
}

/** The extra wrangler arguments that select the persist directory, if any. */
export function persistArguments(environment: NodeJS.ProcessEnv = process.env): string[] {
  const path = persistPathFromEnvironment(environment);
  return path === null ? [] : ['--persist-to', path];
}
