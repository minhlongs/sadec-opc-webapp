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
 *   2. that commit is an **ancestor of `main`** — already merged, not merely
 *      present somewhere in the history graph;
 *   3. that commit has a **completed, successful** `verify` run of its own, whose
 *      provenance is exactly the release gate: the flow's `verify.yml`, triggered
 *      by a `push`, on branch `main`, with `head_sha` equal to the full SHA.
 *
 * What this deliberately does not accept: `workflow_run`, a green run of another
 * workflow, a run that merely exists, a run whose conclusion is `neutral`,
 * `skipped` or `cancelled`, a **pull-request** run (it tests the merge commit, not
 * this tree), a **`workflow_dispatch`** run (nobody proved it came from `main` at
 * the time), and a green run of a *different* commit. "There is a run" and "the
 * gate passed on this commit, on main, from a push" are different claims and only
 * the last one is a reason to deploy.
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
  /** Whether the requested commit is in `<ref>`'s history. See `readComparison`. */
  readonly onRef: boolean;
  /** The raw `status` string the compare API answered, or null when unreadable. */
  readonly comparisonStatus?: string | null;
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

/** The only event that can produce the gate run. */
export const GATE_EVENT = 'push';

/**
 * Why this run is not the gate, or `null` when it is.
 *
 * Every condition is required, and each one exists because of a specific way a
 * "green run" can be green without having tested this commit on `main`:
 *
 *   - the **path**: a green run of `deploy-pilot.yml` proves the workflow file
 *     parses, not that the test suite passed;
 *   - the **head SHA**, compared as the full string: a run of another commit is
 *     the case where a successful run is cited for a tree nobody tested;
 *   - the **event**: a `pull_request` run checks out the merge commit, so it tested
 *     something this branch does not contain; a `workflow_dispatch` run is started
 *     by hand from a ref somebody chose, which is not a push to `main`;
 *   - the **branch**: a push to a feature branch that happens to carry the same
 *     commit object is not the main gate. An absent `head_branch` is unknown, and
 *     unknown is refused — defaulting it to `main` would turn missing data into
 *     evidence;
 *   - **status and conclusion**: a queued or cancelled run has not finished, and
 *     `neutral`/`skipped` are not success.
 */
export function gateRunRejection(run: WorkflowRun, sha: string, ref = TRUSTED_REF): string | null {
  const path = run.path.replace(/\\/g, '/');
  if (!path.endsWith(GATE_WORKFLOW_PATH)) {
    return `it ran ${run.path || '(no path)'}, not ${GATE_WORKFLOW_PATH}`;
  }
  if (run.head_sha.toLowerCase() !== sha.toLowerCase()) {
    return `it tested ${run.head_sha || '(no sha)'}, not ${sha}`;
  }
  if (run.event !== GATE_EVENT) {
    return `it was triggered by "${run.event || '(none)'}", not by a push to ${ref}`;
  }
  if ((run.head_branch ?? '') !== ref) {
    return `it pushed "${run.head_branch ?? '(unknown branch)'}", not ${ref}`;
  }
  if (run.status !== 'completed') return `it is "${run.status || '(no status)'}"`;
  if (run.conclusion !== 'success') return `it concluded "${run.conclusion ?? '(none)'}"`;
  return null;
}

/** A run of the gate workflow that proves this exact commit passed, on `main`. */
export function isSuccessfulGateRun(run: WorkflowRun, sha: string, ref = TRUSTED_REF): boolean {
  return gateRunRejection(run, sha, ref) === null;
}

/**
 * What a `compare` answer means for ancestry — and why the direction matters.
 *
 * The URL is `compare/<sha>...<ref>`, so **`sha` is the base and `ref` is the
 * head**: GitHub answers "how does `main` stand relative to the requested
 * commit". `ahead` therefore means `main` has commits the commit does not, i.e.
 * the commit is in `main`'s history; `identical` means they are the same commit.
 * `behind` means the requested commit is **ahead of** `main`, which is an
 * unmerged commit — the exact case this rule must refuse. `diverged` means
 * neither contains the other.
 *
 * This was wrong in the first version of this file, in the direction that matters:
 * it read `compare/main...<sha>` but accepted `ahead`, which meant an unmerged
 * commit satisfied the ancestry test and only the CI check stood in the way. A
 * fixture cannot catch that, so the URL and this reading are both asserted.
 */
export interface ComparisonReading {
  readonly status: string | null;
  readonly onRef: boolean;
  readonly detail: string;
}

export function readComparison(
  status: string | null | undefined,
  sha: string,
  ref = TRUSTED_REF,
): ComparisonReading {
  const value = typeof status === 'string' && status.trim() !== '' ? status.trim() : null;
  if (value === 'ahead' || value === 'identical') {
    return {
      status: value,
      onRef: true,
      detail:
        value === 'identical'
          ? `${sha} is the tip of ${ref}`
          : `${ref} is ahead of ${sha}: ${sha} is in ${ref}'s history`,
    };
  }
  if (value === 'behind') {
    return {
      status: value,
      onRef: false,
      detail:
        `${sha} is ahead of ${ref}, so it is not merged. A commit that ${ref} does not ` +
        'contain has never been released, whatever its own runs say.',
    };
  }
  if (value === 'diverged') {
    return {
      status: value,
      onRef: false,
      detail: `${sha} and ${ref} diverge: neither contains the other.`,
    };
  }
  return {
    status: value,
    onRef: false,
    detail:
      value === null
        ? 'the compare API returned no status, so ancestry could not be established'
        : `the compare API answered "${value}", which is not an ancestry answer`,
  };
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
    const reading = readComparison(facts.comparisonStatus ?? null, sha, facts.ref);
    failures.push(
      `${sha} is not on ${facts.ref}: ${reading.detail} Only a commit already merged ` +
        `to ${facts.ref} may be deployed; open a pull request first.`,
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
