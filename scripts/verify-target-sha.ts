#!/usr/bin/env node
/**
 * Decide whether a requested commit may be deployed — using logic that does not
 * come from that commit.
 *
 *   pnpm verify-target-sha -- --sha <40-hex> [--ref main] [--repository o/n]
 *                            [--dispatch-ref refs/heads/main]
 *                            [--github-output "$GITHUB_OUTPUT"]
 *
 * The facts it asks for, and refuses without: the commit exists here, it is an
 * **ancestor of `main`** (compare API, `sha` as base and `main` as head — the
 * direction is stated in `readComparison` because getting it backwards accepts an
 * unmerged commit), and there is a completed successful `verify` run **of that
 * exact commit, triggered by a push to `main`**. A pull-request run, a
 * `workflow_dispatch` run, a run from another branch and a green run of a
 * different SHA are all refusals.
 *
 * This replaced `require-main-sha`, and the rename is the point. The old command
 * ran inside the job that had already checked out `inputs.sha`: the workflow
 * executed a package script **from the tree it was about to approve**. A commit
 * that changed `scripts/deploy-ref.ts` — or `package.json` — could therefore
 * approve itself, and pinning the actions to commit SHAs did not help, because
 * the risk was the checked-out code, not the action.
 *
 * So this file is written to be safe to run from the trusted checkout, and it
 * does three things differently:
 *
 *   1. **It reads no repository code.** The decision comes from the GitHub API —
 *      the commit, the compare endpoint and the Actions runs — not from a git
 *      checkout of the requested SHA. Nothing from the requested tree is
 *      executed or imported.
 *   2. **It refuses an untrusted dispatch ref first.** A `workflow_dispatch` runs
 *      the workflow from the selected ref; anything but `refs/heads/main` is that
 *      ref's copy of the rules.
 *   3. **It publishes one fixed output.** The jobs that hold credentials consume
 *      `steps.<id>.outputs.sha`, so there is no path from the operator's raw
 *      input to a checkout except through this decision.
 *
 * Exit codes follow the rest of the scripts: 2 for a usage error, 1 for a
 * refusal, 0 for "this commit may be deployed". It prints the SHA, the run id and
 * the run URL — never a token, never a response body.
 */

import { appendFileSync } from 'node:fs';
import {
  evaluateDeployRef,
  evaluateDispatchRef,
  parseSha,
  readComparison,
  selectGateRun,
  TRUSTED_REF,
  type WorkflowRun,
} from './deploy-ref.ts';

const USAGE = [
  'Usage: pnpm verify-target-sha -- --sha <40-character commit SHA>',
  '         [--ref main] [--repository owner/name] [--dispatch-ref <ref>]',
  '         [--github-output <path>]',
  '',
  'GITHUB_REPOSITORY and GITHUB_OUTPUT are read from the environment when the',
  'flags are absent (GitHub Actions sets both).',
  'GH_TOKEN or GITHUB_TOKEN must be set for the API calls.',
].join('\n');

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value.trim();
}

function refuse(message: string, code: number): never {
  process.stderr.write(`\n${message}\n`);
  process.exit(code);
}

const requested = flagValue('--sha');
if (requested === null) {
  refuse(`Error: verify-target-sha needs --sha.\n${USAGE}`, 2);
}

const ref = flagValue('--ref') ?? TRUSTED_REF;
const repository = flagValue('--repository') ?? (process.env.GITHUB_REPOSITORY ?? '').trim();
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
  refuse(`Error: verify-target-sha needs a repository as owner/name, got "${repository}".\n${USAGE}`, 2);
}

// The dispatch ref is checked before anything else: if the workflow itself came
// from a branch, every later answer is that branch's answer.
const dispatchRef = flagValue('--dispatch-ref');
if (dispatchRef !== null) {
  const refused = evaluateDispatchRef(dispatchRef, ref);
  if (refused.length > 0) {
    refuse(`Refusing to verify anything:\n${refused.map((line) => `  - ${line}`).join('\n')}`, 1);
  }
}

const sha = parseSha(requested);
if (sha === null) {
  refuse(
    `Error: "${requested}" is not a full 40-character commit SHA.\n` +
      'Branches, tags, short SHAs and refs are refused: only a full SHA names the\n' +
      'tree that CI proved. Nothing was checked and nothing may be deployed.',
    2,
  );
}

const token = (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim();
if (token === '') {
  refuse(
    'Error: no GH_TOKEN or GITHUB_TOKEN in the environment.\n' +
      'The decision is read from the GitHub API, so it cannot be made offline here.\n' +
      'This is a refusal, not a pass: an unanswerable question is not a yes.',
    1,
  );
}

// Overridable only so a test can point the same code at a local stand-in. The
// default is the real API, and no workflow sets this.
const API = (process.env.SADEC_GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/$/, '');
const headers: Record<string, string> = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'sadec-flow-verify-target-sha',
};

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

async function get(path: string): Promise<ApiResult> {
  const response = await fetch(`${API}${path}`, { headers });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

process.stdout.write(
  `Commit:     ${sha}\n` +
    `Branch:     ${ref}\n` +
    `Repository: ${repository}\n` +
    (dispatchRef === null ? '' : `Dispatched: ${dispatchRef} (trusted)\n`),
);

// 1. The commit has to exist in this repository. A SHA from a fork is not this
//    repository's tree, whatever it hashes to.
const commit = await get(`/repos/${repository}/commits/${sha}`);
if (commit.status !== 200) {
  refuse(
    `Refusing: ${sha} could not be read from ${repository} (HTTP ${commit.status}).\n` +
      'A commit that this repository does not have cannot be one of its releases.',
    1,
  );
}

// 2. Ancestry, from the compare endpoint rather than `git merge-base`.
//
//    The URL is `compare/<sha>...<ref>`: the requested commit is the **base** and
//    `main` is the **head**, so the answer reads "how does main stand relative to
//    this commit". `ahead` means main contains commits this one does not — the
//    commit is merged. `behind` means the commit is ahead of main, which is exactly
//    an unmerged commit, and reads as the opposite of what it looks like if the
//    arguments are swapped. `readComparison` owns that reading; this line only
//    builds the URL.
const comparison = await get(`/repos/${repository}/compare/${sha}...${ref}`);
let comparisonStatus: string | null = null;
let onRef = false;
if (comparison.status !== 200) {
  process.stderr.write(
    `Warning: the compare API answered ${comparison.status}, so "is ${sha} on ${ref}" ` +
      'cannot be answered. Treating that as "not on the branch".\n',
  );
} else {
  const raw = (comparison.body as { status?: unknown } | null)?.status;
  comparisonStatus = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  const reading = readComparison(comparisonStatus, sha, ref);
  onRef = reading.onRef;
  process.stdout.write(
    `Compare:    ${sha}...${ref} is "${comparisonStatus ?? '(missing)'}" — ${reading.detail}\n`,
  );
}

// 3. The gate run, read from the runs API. One page of fifty is enough: a commit
//    with more runs than that means the wrong question is being asked.
let runs: WorkflowRun[] = [];
const runsResponse = await get(
  `/repos/${repository}/actions/workflows/verify.yml/runs?head_sha=${sha}&per_page=50`,
);
if (runsResponse.status !== 200) {
  process.stderr.write(
    `Warning: the Actions runs API answered ${runsResponse.status}, so the gate run ` +
      'cannot be confirmed. An unconfirmed gate is a refusal, not a pass.\n',
  );
} else {
  const raw = (runsResponse.body as { workflow_runs?: unknown }).workflow_runs;
  if (Array.isArray(raw)) {
    runs = raw.map((entry) => {
      const run = entry as Record<string, unknown>;
      return {
        id: Number(run.id ?? 0),
        head_sha: String(run.head_sha ?? ''),
        path: String(run.path ?? ''),
        event: String(run.event ?? ''),
        status: String(run.status ?? ''),
        conclusion: run.conclusion === undefined || run.conclusion === null ? null : String(run.conclusion),
        head_branch: run.head_branch === undefined || run.head_branch === null ? null : String(run.head_branch),
      };
    });
  }
}

const failures = evaluateDeployRef({ requested: sha, ref, onRef, comparisonStatus, runs });
if (failures.length > 0) {
  refuse(
    'Refusing to deploy:\n' + failures.map((line) => `  - ${line}`).join('\n') + '\n\n' +
      'Nothing was checked out, built or uploaded.',
    1,
  );
}

const gate = selectGateRun(runs, sha, ref);
if (gate === null) {
  // Unreachable by construction: `evaluateDeployRef` already refused. Kept as a
  // belt-and-braces guard so a future edit to the rule cannot silently pass here.
  refuse('Refusing: no successful gate run was selected, which should be impossible here.', 1);
}

const outputPath = flagValue('--github-output') ?? (process.env.GITHUB_OUTPUT ?? '').trim();
if (outputPath === '') {
  process.stdout.write(
    '\nNote: GITHUB_OUTPUT is not set, so no output was published. In a workflow that\n' +
      'would leave the next job with nothing to check out — which is a failure, not a\n' +
      'convenience.\n',
  );
} else {
  // One line, one name. Every downstream job reads `needs.<job>.outputs.sha`, so
  // the operator's raw input never reaches a checkout.
  appendFileSync(outputPath, `sha=${sha}\n`);
}

process.stdout.write(
  `\nGate:       run ${gate.id} (${gate.event}) concluded success\n` +
    `Evidence:   https://github.com/${repository}/actions/runs/${gate.id}\n` +
    `Output:     sha=${sha}\n` +
    '\nThis commit may be deployed. Downstream jobs must check out this output, not\n' +
    'the input they were dispatched with.\n',
);
