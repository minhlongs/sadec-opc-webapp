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
 * And one rule about *who* asks: the workflow that checks the SHA must not be
 * running code from the SHA it is checking. A workflow that checks out
 * `inputs.sha` and then executes the checker from that checkout has handed the
 * decision to the thing being decided — the tree under test can replace the
 * checker, or the package script it calls. So the checking job checks out the
 * **trusted default branch**, holds no secret, and publishes the verified SHA as
 * a job output; the jobs that hold credentials consume that output and nothing
 * else. `evaluateDispatchRef` covers the other half: a `workflow_dispatch` from a
 * branch runs that branch's copy of the workflow, so anything but `main` is
 * refused before the first step does any work.
 *
 * Nothing here talks to the network. `scripts/verify-target-sha.ts` gathers the
 * facts — the compare API and the Actions runs API, with no git checkout of the
 * requested commit — and this file decides. That split is why the decision has
 * tests without a mock server.
 */

/** A run as the Actions API reports it, reduced to the fields the rule reads. */
export interface WorkflowRun {
  readonly id: number;
  readonly head_sha: string;
  readonly path: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  /** The branch a `push` run was triggered from. Absent on older API objects. */
  readonly head_branch?: string | null;
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
 * The only ref a target may come from, and the only ref a dispatch may start on.
 *
 * A `workflow_dispatch` runs the workflow file **from the selected ref**, so a
 * dispatch on a branch executes that branch's YAML. Everything after that
 * dispatch inherits the branch's idea of what to check, which is precisely the
 * boundary this repository is closing.
 */
export const TRUSTED_REF = 'main';

/** The full ref name a trusted dispatch must carry. */
export const TRUSTED_REF_NAME = `refs/heads/${TRUSTED_REF}`;

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
export function isSuccessfulGateRun(run: WorkflowRun, sha: string, ref = TRUSTED_REF): boolean {
  const sameCommit =
    run.head_sha.toLowerCase() === sha &&
    run.path.replace(/\\/g, '/').endsWith(GATE_WORKFLOW_PATH) &&
    run.status === 'completed' &&
    run.conclusion === 'success';

  if (!sameCommit) return false;

  // A pull-request run checks out the merge commit on the base, so its `head_sha`
  // is not even this tree's commit; a `workflow_run`-triggered run reports the
  // original event. Neither is the gate on `main` that this rule asks for.
  if (run.event === 'workflow_dispatch') return true;

  // A `push` run is only the gate when the branch pushed was the trusted one.
  // Without this, a green run on a feature branch that happens to carry the same
  // commit object would be accepted as the main gate.
  return run.event === 'push' && (run.head_branch ?? ref) === ref;
}

/** The gate run to cite as evidence, newest first in the list the API returns. */
export function selectGateRun(
  runs: readonly WorkflowRun[],
  sha: string,
  ref = TRUSTED_REF,
): WorkflowRun | null {
  return runs.find((run) => isSuccessfulGateRun(run, sha, ref)) ?? null;
}

/** A short, honest description of what the runs list actually contained. */
export function summariseRuns(runs: readonly WorkflowRun[]): string {
  const gate = runs.filter((run) =>
    run.path.replace(/\\/g, '/').endsWith(GATE_WORKFLOW_PATH),
  );
  if (gate.length === 0) {
    return `no run of ${GATE_WORKFLOW_PATH} was reported for this commit at all`;
  }
  const described = gate.map(
    (run) =>
      `${run.event}${run.head_branch ? `@${run.head_branch}` : ''}/${run.status}/${run.conclusion ?? 'none'}`,
  );
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
      `${sha} is not on ${facts.ref}. Only a commit already merged to ` +
        `${facts.ref} may be deployed; open a pull request first.`,
    );
  }

  if (selectGateRun(facts.runs, sha, facts.ref) === null) {
    failures.push(
      `there is no successful run of ${GATE_WORKFLOW_PATH} for ${sha}: ` +
        `${summariseRuns(facts.runs)}. Wait for the gate, or pick a commit ` +
        'that already has one.',
    );
  }

  return failures;
}

/**
 * The dispatch-ref rule: the workflow may only be started from the trusted ref.
 *
 * Returns the refusal, or an empty list. `dispatchRef` is `GITHUB_REF`, which is
 * `refs/heads/<branch>` for a branch dispatch, `refs/tags/<tag>` for a tag and
 * `refs/pull/<n>/merge` for a pull request.
 */
export function evaluateDispatchRef(dispatchRef: string, trustedRef = TRUSTED_REF): string[] {
  const expected = `refs/heads/${trustedRef}`;
  if (dispatchRef === expected) return [];
  return [
    `this workflow was dispatched from "${dispatchRef || '(empty)'}", but it may only ` +
      `run from ${expected}. A dispatch from another ref executes that ref's copy of ` +
      "this workflow, with that ref's idea of how a commit is checked, so nothing " +
      'after this point can be trusted. Re-run it from the default branch.',
  ];
}
