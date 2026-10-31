/**
 * Which commit a deployment workflow is allowed to deploy.
 *
 * A manual workflow still has to name a commit, and a manual workflow is exactly
 * where a wrong commit gets deployed: the operator picks a branch, gets its tip
 * rather than the commit CI proved, or pastes the SHA of a pull request whose
 * `verify` run was green *for a different tree*. So the rule is stated once, in
 * code that a test can exercise, and the workflow asks it:
 *
 *   1. the argument is a **full 40-character** SHA, not a branch, a tag, a short
 *      SHA or a ref;
 *   2. that commit is on `main` — reachable from `origin/main` right now;
 *   3. that commit has a **completed, successful** `verify` run of its own.
 *
 * What this deliberately does not accept: `workflow_run`, a green run of another
 * workflow, a run that merely exists, or a run whose conclusion is `neutral`,
 * `skipped` or `cancelled`. "There is a run" and "the gate passed" are different
 * claims and only the second one is a reason to deploy.
 *
 * Nothing here talks to the network. `scripts/require-main-sha.ts` gathers the
 * facts — `git merge-base --is-ancestor` and the Actions runs API — and this file
 * decides. That split is why the decision has tests without a mock server.
 */

/** A run as the Actions API reports it, reduced to the fields the rule reads. */
export interface WorkflowRun {
  readonly id: number;
  readonly head_sha: string;
  readonly path: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** Everything the decision depends on. Gathered by the CLI, supplied by a test. */
export interface DeployRefFacts {
  /** What the operator asked to deploy. Untrusted: it may be a branch name. */
  readonly requested: string;
  /** The branch that must contain the commit, without the remote prefix. */
  readonly ref: string;
  /** Whether `git merge-base --is-ancestor <sha> origin/<ref>` said yes. */
  readonly onRef: boolean;
  /** Runs for this commit, as reported by the API. */
  readonly runs: readonly WorkflowRun[];
}

/** The workflow whose success is the gate. A file path, because that is stable. */
export const GATE_WORKFLOW_PATH = '.github/workflows/verify.yml';

/**
 * A full SHA, lowercase hex, and nothing else.
 *
 * Case is normalised rather than rejected: an operator copying from a URL can
 * easily get upper case, and a SHA has no meaning in one case only. Everything
 * that is not 40 hex characters is refused — including an abbreviated SHA, which
 * is ambiguous in a way that looks precise.
 */
export function parseSha(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** A run of the gate workflow that proves this exact commit passed. */
export function isSuccessfulGateRun(run: WorkflowRun, sha: string): boolean {
  return (
    run.head_sha.toLowerCase() === sha &&
    run.path.replace(/\\/g, '/').endsWith(GATE_WORKFLOW_PATH) &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    // A pull-request run checks out the merge commit on the base, and a
    // `workflow_run`-triggered run reports the original event. Neither is the
    // `push` gate on `main` that this rule is asking for.
    (run.event === 'push' || run.event === 'workflow_dispatch')
  );
}

/** The gate run to cite as evidence, newest first in the list the API returns. */
export function selectGateRun(runs: readonly WorkflowRun[], sha: string): WorkflowRun | null {
  return runs.find((run) => isSuccessfulGateRun(run, sha)) ?? null;
}

/** A short, honest description of what the runs list actually contained. */
export function summariseRuns(runs: readonly WorkflowRun[]): string {
  const gate = runs.filter((run) =>
    run.path.replace(/\\/g, '/').endsWith(GATE_WORKFLOW_PATH),
  );
  if (gate.length === 0) {
    return `no run of ${GATE_WORKFLOW_PATH} was reported for this commit at all`;
  }
  const described = gate.map((run) => `${run.event}/${run.status}/${run.conclusion ?? 'none'}`);
  return `the runs of ${GATE_WORKFLOW_PATH} for this commit are: ${described.join(', ')}`;
}

/**
 * The failures, in the order an operator should fix them. Empty means deploy.
 *
 * Every message names what was found as well as what was required, because the
 * operator reading it in a failed job cannot inspect this process.
 */
export function evaluateDeployRef(facts: DeployRefFacts): string[] {
  const sha = parseSha(facts.requested);

  if (sha === null) {
    return [
      `"${facts.requested}" is not a full 40-character commit SHA. ` +
        'A branch name, a tag, a short SHA and a ref are all refused, because ' +
        'only a full SHA names the tree that CI proved.',
    ];
  }

  const failures: string[] = [];

  if (!facts.onRef) {
    failures.push(
      `${sha} is not on origin/${facts.ref}. Only a commit already merged to ` +
        `${facts.ref} may be deployed; open a pull request first.`,
    );
  }

  if (selectGateRun(facts.runs, sha) === null) {
    failures.push(
      `there is no successful run of ${GATE_WORKFLOW_PATH} for ${sha}: ` +
        `${summariseRuns(facts.runs)}. Wait for the gate, or pick a commit ` +
        'that already has one.',
    );
  }

  return failures;
}
