/**
 * What `deploy:preview` insists on before it deploys.
 *
 * Split out of the script so it can be tested without starting a deploy, and so
 * the list is one list rather than a condition spread through the file.
 *
 * Two values, and neither is optional:
 *
 *   - `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are what the Worker verifies the
 *     Access JWT against. Without them it fails closed on every route — correct,
 *     but it looks like an outage rather than a missing setting.
 *
 * What is deliberately **not** here: `FOUNDER_EMAIL` and `FOUNDER_SUB`. Those were
 * required by an earlier version of this script on the stated grounds that
 * "bootstrap grants founder_admin only to the identity configured here". No code
 * ever read them: the Worker has no bootstrap path, and the grant is made by
 * `pnpm bootstrap:founder` against the database. Requiring a value that nothing
 * reads does not protect anything — it taught an operator to set a variable and
 * expect access, which is exactly the failure this repository spent a round
 * fixing. The identity for the bootstrap is an argument to that command, taken
 * from a verified Access subject, and it is recorded in the audit row.
 */
export interface DeployEnvironment {
  readonly ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly ACCESS_AUD?: string | undefined;
}

/** The variables a deploy cannot proceed without, in the order to report them. */
export const REQUIRED_DEPLOY_VALUES = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'] as const;

export function missingDeployConfiguration(environment: DeployEnvironment): string[] {
  const missing: string[] = [];
  for (const name of REQUIRED_DEPLOY_VALUES) {
    const value = environment[name];
    if (value === undefined || value.trim() === '') missing.push(name);
  }
  return missing;
}
