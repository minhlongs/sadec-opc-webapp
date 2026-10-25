#!/usr/bin/env node
/**
 * Deploys the pilot Worker — the private preview.
 *
 * §6 is explicit that an unauthenticated request must be refused and that an
 * alternative URL is protected, and §15 case 17 is only evidence when `curl`
 * shows a redirect or a refusal. So this command refuses to deploy until the
 * Access configuration is present, rather than publishing something reachable
 * and trusting a later step to close it.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireEnvironment, printTarget } from './require-environment.ts';

const environment = requireEnvironment(process, 'deploy:preview');

printTarget(process, {
  command: 'deploy:preview',
  environment,
  database: 'n/a',
  extra: [
    'This deploys the pilot Worker. There is no public launch from this command,',
    'and no domain is purchased.',
  ],
});

// Both must be present. Without them the Worker would fail closed on every API
// route, which is correct behaviour but not a usable preview, and a deploy that
// silently produces 503s looks like an outage rather than a missing setting.
function missingConfiguration() {
  const missing = [];
  const teamDomain = process.env.ACCESS_TEAM_DOMAIN;
  const audience = process.env.ACCESS_AUD;
  if (!teamDomain || teamDomain.trim() === '') missing.push('ACCESS_TEAM_DOMAIN');
  if (!audience || audience.trim() === '') missing.push('ACCESS_AUD');
  return missing;
}

const missing = missingConfiguration();

if (missing.length > 0) {
  process.stderr.write(
    `\nRefusing to deploy the pilot preview: missing ${missing.join(' and ')}.\n\n` +
      'The pilot Worker verifies the Access JWT itself, and those two values are\n' +
      'what it verifies against. Read them from the dashboard: Zero Trust > Access\n' +
      'controls > Applications > the pilot application > Additional settings.\n\n' +
      'Add them to .dev.vars for a local run, or set them as Worker secrets for\n' +
      'a deployed one. Never commit them: .dev.vars is gitignored precisely because\n' +
      'a leaked audience tag allows a forged token to be signed correctly.\n',
  );
  process.exit(2);
}

const founderIdentity = process.env.FOUNDER_EMAIL ?? process.env.FOUNDER_SUB;
if (!founderIdentity || founderIdentity.trim() === '') {
  process.stderr.write(
    '\nRefusing to deploy the pilot preview: missing FOUNDER_EMAIL or FOUNDER_SUB.\n\n' +
      'Bootstrap grants founder_admin only to the identity configured here. With no\n' +
      'value the bootstrap would either grant nothing, leaving the pilot locked, or\n' +
      'worse, fall back to the first person to log in — which §6 forbids. Both are\n' +
      'refused at deploy time instead.\n',
  );
  process.exit(2);
}

/**
 * The config the deploy actually reads.
 *
 * `wrangler deploy --env pilot` does not read `wrangler.jsonc`: the Cloudflare
 * Vite plugin redirects it to the config it generates under `dist/`. Asserting on
 * the source file instead would pass while the deployment had no database and no
 * `APP_ENV`, so every guarded route refused on a Worker that had just passed every
 * local gate and every unit test.
 *
 * The failure this catches is silent by nature — the deploy succeeds — so the only
 * place to catch it is here.
 */
function assertDeployConfigIsUsable(): void {
  const generated = join('dist', 'sadec_flow', 'wrangler.json');
  let config: {
    d1_databases?: { binding?: unknown }[];
    env?: { pilot?: { vars?: { APP_ENV?: unknown }; name?: unknown } };
    vars?: { APP_ENV?: unknown };
  };
  try {
    config = JSON.parse(readFileSync(generated, 'utf8'));
  } catch {
    process.stderr.write(
      `\nRefusing to deploy the pilot preview: ${generated} could not be read.\n\n` +
        'Run `pnpm build` first. The deploy reads the config the build generates,\n' +
        'so a build is a precondition of the deploy, not a separate step.\n',
    );
    process.exit(2);
  }

  const bindings = (config.d1_databases ?? []).map((entry) =>
    String(entry.binding ?? ''),
  );
  if (!bindings.includes('sadec_pilot')) {
    process.stderr.write(
      '\nRefusing to deploy the pilot preview: the deployment has no sadec_pilot binding.\n\n' +
        'The generated config lists only: ' +
        (bindings.length === 0 ? '(none)' : bindings.join(', ')) +
        '.\n\nWithout it every guarded route refuses. Declare the pilot database at\n' +
        'the top level of wrangler.jsonc — not only under `env.pilot`, which the\n' +
        'Vite plugin drops when it generates this file.\n',
    );
    process.exit(2);
  }
}

assertDeployConfigIsUsable();

/**
 * The deploy, and why it passes `--name` and `--var` explicitly.
 *
 * The generated config has no `env` section — the Vite plugin drops it — so
 * `--env pilot` has nothing to select and the Worker would deploy with no
 * `APP_ENV` and the local Worker's name. `APP_ENV` decides which D1 binding and
 * which identity path the Worker uses, so leaving it unset would make the pilot
 * read the demo database's binding name and take the dev-identity refusal path.
 * Both are stated here instead of inherited from a config that no longer carries
 * them.
 *
 * `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `FOUNDER_EMAIL` stay secrets: they are
 * set as Worker secrets, never passed on a command line a shell history records.
 */
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'deploy',
    '--env',
    'pilot',
    '--name',
    'sadec-flow-pilot',
    '--var',
    'APP_ENV:pilot',
    '--keep-vars',
  ],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  process.stderr.write(
    `\nPilot deploy failed with exit status ${result.status}.\n`,
  );
  process.exit(result.status ?? 1);
}

process.stdout.write(
  '\nPilot Worker deployed.\n' +
    'Before calling this PRIVATE_PREVIEW_VERIFIED, run §15 case 17 against the\n' +
    'live URL and record the actual output: an unauthenticated request must be\n' +
    'refused, a forged identity header must be refused, and the dev identity\n' +
    'endpoint must not exist on a deployment.\n',
);
