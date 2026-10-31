#!/usr/bin/env node
/**
 * Refuses to let a deployment workflow name a commit it should not deploy.
 *
 *   pnpm require-main-sha -- --sha <40-hex> [--ref main] [--repository o/n]
 *
 * The rule itself lives in `scripts/deploy-ref.ts`, where a test can exercise it
 * without a network. This file only gathers the two facts the rule needs:
 *
 *   - is the commit on `origin/main`? (`git fetch` then `git merge-base`)
 *   - does that commit have a successful `verify` run of its own? (Actions API)
 *
 * Exit codes follow the rest of the scripts: 2 when the command was called
 * wrongly, 1 when the answer is "no", 0 when it is "yes".
 *
 * It prints the SHA, the run id and the run URL — never a token, never a
 * response body. `gh` reads the token from `GH_TOKEN`, which the workflow passes
 * as `${{ github.token }}`; nothing here echoes the environment.
 */

import { spawnSync } from 'node:child_process';
import { evaluateDeployRef, parseSha, selectGateRun, type WorkflowRun } from './deploy-ref.ts';

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value.trim();
}

const usage = [
  'Usage: pnpm require-main-sha -- --sha <40-character commit SHA>',
  '         [--ref main] [--repository owner/name]',
  '',
  'GITHUB_REPOSITORY is used when --repository is absent (GitHub Actions sets it).',
  'GH_TOKEN must be set for the Actions runs API.',
].join('\n');

const requested = flagValue('--sha');
if (requested === null) {
  process.stderr.write(`Error: require-main-sha needs --sha.\n${usage}\n`);
  process.exit(2);
}

// Checked before anything is run, so a typo costs nothing and a branch name is
// never quietly resolved to whatever it points at today.
if (parseSha(requested) === null) {
  process.stderr.write(
    `Error: "${requested}" is not a full 40-character commit SHA.\n` +
      'Branches, tags, short SHAs and refs are refused: only a full SHA names\n' +
      'the tree that CI proved.\n',
  );
  process.exit(2);
}
const sha = parseSha(requested) as string;

const ref = flagValue('--ref') ?? 'main';
const repository = flagValue('--repository') ?? process.env.GITHUB_REPOSITORY?.trim() ?? '';
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
  process.stderr.write(
    `Error: require-main-sha needs a repository as owner/name, got "${repository}".\n${usage}\n`,
  );
  process.exit(2);
}

function run(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    // No shell: `gh` and `git` take arguments, not a command line to interpret.
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

process.stdout.write(`Commit:     ${sha}\nBranch:     origin/${ref}\nRepository: ${repository}\n`);

// The fetch is explicit and unfiltered on purpose: a stale remote-tracking ref
// would answer a question about the past, and the question is about now.
const fetch = run('git', ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`]);
if (fetch.status !== 0) {
  process.stderr.write(
    `\nError: could not fetch origin/${ref}, so "is this commit on ${ref}" cannot be answered.\n` +
      `git exited ${fetch.status}. Nothing was deployed.\n${fetch.stderr.trim()}\n`,
  );
  process.exit(1);
}

const ancestor = run('git', ['merge-base', '--is-ancestor', sha, `refs/remotes/origin/${ref}`]);
const onRef = ancestor.status === 0;
if (ancestor.status !== 0 && ancestor.status !== 1) {
  process.stderr.write(
    `\nError: git merge-base exited ${ancestor.status}; treating that as "not on ${ref}".\n` +
      `${ancestor.stderr.trim()}\n`,
  );
}

// One page is enough: a commit gets a handful of runs, and a hundred means
// something else is wrong with the question being asked.
const api = run('gh', [
  'api',
  `repos/${repository}/actions/workflows/verify.yml/runs?head_sha=${sha}&per_page=50`,
]);

let runs: WorkflowRun[] = [];
let apiReadable = api.status === 0;
if (apiReadable) {
  try {
    const body = JSON.parse(api.stdout) as {
      workflow_runs?: {
        id: number;
        head_sha: string;
        path: string;
        event: string;
        status: string;
        conclusion: string | null;
      }[];
    };
    runs = (body.workflow_runs ?? []).map((entry) => ({
      id: entry.id,
      head_sha: entry.head_sha,
      path: entry.path,
      event: entry.event,
      status: entry.status,
      conclusion: entry.conclusion,
    }));
  } catch {
    apiReadable = false;
  }
}

if (!apiReadable) {
  // Not fatal on its own: the rule below will refuse for the absence of a run,
  // and saying why is more useful than a stack trace. A missing `checks: read`
  // or an expired token looks exactly like this.
  process.stderr.write(
    `\nWarning: the Actions runs API could not be read (gh exited ${api.status}).\n` +
      'The gate run for this commit therefore cannot be confirmed, and an\n' +
      'unconfirmed gate is a refusal, not a pass.\n' +
      (api.stderr.trim() === '' ? '' : `${api.stderr.trim()}\n`),
  );
}

// `runs` is empty when the API could not be read, so the gate check refuses on
// its own. Passing `onRef` straight through keeps the two questions separate.
const failures = evaluateDeployRef({ requested: sha, ref, onRef, runs });

if (failures.length > 0) {
  process.stderr.write('\nRefusing to deploy:\n' + failures.map((line) => `  - ${line}\n`).join(''));
  process.exit(1);
}

const gate = selectGateRun(runs, sha) as WorkflowRun;
process.stdout.write(
  `Gate:       run ${gate.id} (${gate.event}) concluded success\n` +
    `Evidence:   https://github.com/${repository}/actions/runs/${gate.id}\n` +
    '\nThis commit may be deployed. It has been checked out at this exact SHA.\n',
);
