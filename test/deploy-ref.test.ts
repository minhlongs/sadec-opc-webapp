import { describe, expect, it } from 'vitest';
import {
  evaluateDeployRef,
  evaluateDispatchRef,
  gateRunRejection,
  isSuccessfulGateRun,
  parseSha,
  readComparison,
  selectGateRun,
  summariseRuns,
  GATE_WORKFLOW_PATH,
  type WorkflowRun,
} from '../scripts/deploy-ref.ts';

/**
 * The rule a manual deploy workflow asks before it deploys anything.
 *
 * A wrong answer here is expensive in a way unit tests usually are not: it either
 * blocks a deploy that should have happened (annoying, visible) or permits one
 * from a tree CI never proved (silent, and the reason the rule exists). Both are
 * covered, and each refusal names the case in the test title so a failure says
 * which rule broke.
 */

const SHA = 'aa6bdc8ef1137dd88daf49882d09b821965c3f76';
const OTHER_SHA = '7796ce41c6e7b0a1d3a71a9a4b0e2f3a4b5c6d7e';

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 41199722562,
    head_sha: SHA,
    path: GATE_WORKFLOW_PATH,
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

describe('parseSha', () => {
  it('accepts a full 40-character SHA', () => {
    expect(parseSha(SHA)).toBe(SHA);
  });

  it('normalises upper case rather than refusing it', () => {
    expect(parseSha(SHA.toUpperCase())).toBe(SHA);
  });

  it('refuses an abbreviated SHA, which looks precise and is ambiguous', () => {
    expect(parseSha('aa6bdc8')).toBeNull();
  });

  it('refuses a branch name, a tag, a ref and an empty value', () => {
    for (const value of ['main', 'v1.0.0', 'refs/heads/main', '', '   ', null, undefined]) {
      expect(parseSha(value)).toBeNull();
    }
  });

  it('refuses a SHA with anything appended', () => {
    expect(parseSha(`${SHA}\n`)).toBe(SHA);
    expect(parseSha(`${SHA}-dirty`)).toBeNull();
    expect(parseSha(`x${SHA}`)).toBeNull();
  });
});

describe('isSuccessfulGateRun', () => {
  it('accepts a completed, successful push run of the gate workflow', () => {
    expect(isSuccessfulGateRun(run(), SHA)).toBe(true);
  });

  it('refuses a successful workflow_dispatch run: nobody proved it came from main', () => {
    // A dispatched run of `verify` reports a green conclusion and is started by
    // hand from whatever ref the operator chose. It is not the release gate, and
    // accepting it would let a branch run stand in for a push to `main`.
    expect(isSuccessfulGateRun(run({ event: 'workflow_dispatch' }), SHA)).toBe(false);
    expect(gateRunRejection(run({ event: 'workflow_dispatch' }), SHA)).toContain('not by a push');
  });

  it('refuses a run whose head_branch is missing, because unknown is not main', () => {
    // Defaulting an absent branch to `main` turns missing data into evidence.
    expect(isSuccessfulGateRun(run({ head_branch: null }), SHA)).toBe(false);
    expect(isSuccessfulGateRun(run({ head_branch: undefined }), SHA)).toBe(false);
  });

  it('accepts the head_sha case-insensitively but only as the full SHA', () => {
    expect(isSuccessfulGateRun(run({ head_sha: SHA.toUpperCase() }), SHA)).toBe(true);
    expect(isSuccessfulGateRun(run({ head_sha: SHA.slice(0, 12) }), SHA)).toBe(false);
  });

  it('names the reason a run was refused, because the operator cannot read this file', () => {
    expect(gateRunRejection(run({ head_sha: OTHER_SHA }), SHA)).toContain(OTHER_SHA);
    expect(gateRunRejection(run({ path: '.github/workflows/deploy-pilot.yml' }), SHA)).toContain(
      'deploy-pilot.yml',
    );
    expect(gateRunRejection(run({ head_branch: 'feat/thing' }), SHA)).toContain('feat/thing');
    expect(gateRunRejection(run({ status: 'queued', conclusion: null }), SHA)).toContain('queued');
    expect(gateRunRejection(run(), SHA)).toBeNull();
  });

  it('refuses a run of a different commit, even with a green conclusion', () => {
    expect(isSuccessfulGateRun(run({ head_sha: OTHER_SHA }), SHA)).toBe(false);
  });

  it('refuses a run of another workflow', () => {
    expect(isSuccessfulGateRun(run({ path: '.github/workflows/deploy-pilot.yml' }), SHA)).toBe(false);
  });

  it('refuses a pull-request run: it checked out a merge commit, not this tree', () => {
    expect(isSuccessfulGateRun(run({ event: 'pull_request' }), SHA)).toBe(false);
  });

  it('refuses a run that is still going, or that failed, or that was skipped', () => {
    expect(isSuccessfulGateRun(run({ status: 'in_progress', conclusion: null }), SHA)).toBe(false);
    expect(isSuccessfulGateRun(run({ conclusion: 'failure' }), SHA)).toBe(false);
    expect(isSuccessfulGateRun(run({ conclusion: 'cancelled' }), SHA)).toBe(false);
    expect(isSuccessfulGateRun(run({ conclusion: 'neutral' }), SHA)).toBe(false);
    expect(isSuccessfulGateRun(run({ conclusion: 'skipped' }), SHA)).toBe(false);
  });
});

describe('selectGateRun', () => {
  it('picks the gate run out of a list that also holds other events', () => {
    const chosen = selectGateRun(
      [
        run({ id: 1, event: 'pull_request', conclusion: 'success' }),
        run({ id: 2, event: 'pull_request', conclusion: 'failure' }),
        run({ id: 3 }),
      ],
      SHA,
    );
    expect(chosen?.id).toBe(3);
  });

  it('returns null when the list has no gate run at all', () => {
    expect(selectGateRun([run({ event: 'pull_request' })], SHA)).toBeNull();
    expect(selectGateRun([], SHA)).toBeNull();
  });
});

describe('summariseRuns', () => {
  it('says plainly when the gate workflow never ran for the commit', () => {
    expect(summariseRuns([])).toContain('no run of .github/workflows/verify.yml');
    expect(summariseRuns([run({ path: '.github/workflows/other.yml' })])).toContain('no run of');
  });

  it('lists what the gate runs actually were, including the conclusion', () => {
    const text = summariseRuns([
      run({ event: 'pull_request', head_branch: 'arena/round-18', conclusion: 'failure' }),
    ]);
    expect(text).toContain('pull_request@arena/round-18/completed/failure');
  });
});

describe('evaluateDeployRef', () => {
  it('permits a commit on main with a successful gate run', () => {
    expect(evaluateDeployRef({ requested: SHA, ref: 'main', onRef: true, runs: [run()] })).toEqual([]);
  });

  it('refuses a branch name before it asks git anything', () => {
    const failures = evaluateDeployRef({ requested: 'main', ref: 'main', onRef: true, runs: [run()] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('not a full 40-character commit SHA');
  });

  it('refuses a commit that is not on main, even with a green gate run', () => {
    const failures = evaluateDeployRef({
      requested: SHA,
      ref: 'main',
      onRef: false,
      comparisonStatus: 'behind',
      runs: [run()],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('is not on main');
    expect(failures[0]).toContain('ahead of main');
  });

  it('refuses an unmerged commit whose only green run was dispatched', () => {
    // The combination the two separate rules exist for: the ancestry answer says
    // "behind" (the commit is ahead of main) and the only successful run is a
    // workflow_dispatch. Either rule alone would refuse it; this asserts the pair
    // together still refuses rather than the green run carrying it through.
    const failures = evaluateDeployRef({
      requested: SHA,
      ref: 'main',
      onRef: false,
      comparisonStatus: 'behind',
      runs: [run({ event: 'workflow_dispatch', head_branch: 'feat/unmerged' })],
    });
    expect(failures).toHaveLength(2);
  });

  it('says the compare answer could not be read when there was none', () => {
    const failures = evaluateDeployRef({
      requested: SHA,
      ref: 'main',
      onRef: false,
      comparisonStatus: null,
      runs: [run()],
    });
    expect(failures[0]).toContain('ancestry could not be established');
  });

  it('refuses a commit with no successful gate run, and says what was found', () => {
    const failures = evaluateDeployRef({
      requested: SHA,
      ref: 'main',
      onRef: true,
      runs: [run({ conclusion: 'failure' })],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('no successful run of .github/workflows/verify.yml');
    expect(failures[0]).toContain('push@main/completed/failure');
  });

  it('reports both failures when the commit is off main and unproven', () => {
    const failures = evaluateDeployRef({ requested: SHA, ref: 'main', onRef: false, runs: [] });
    expect(failures).toHaveLength(2);
  });

  it('refuses when the runs list is empty because the API could not be read', () => {
    // `require-main-sha` passes [] when the API failed, so an unreadable API is a
    // refusal through this path rather than a special case in the CLI.
    const failures = evaluateDeployRef({ requested: SHA, ref: 'main', onRef: true, runs: [] });
    expect(failures).toHaveLength(1);
  });
});

describe('evaluateDispatchRef', () => {
  it('accepts a dispatch from the default branch', () => {
    expect(evaluateDispatchRef('refs/heads/main')).toEqual([]);
  });

  it('refuses a dispatch from any other branch', () => {
    // A `workflow_dispatch` runs the workflow file from the selected ref, so a
    // branch dispatch executes that branch's version of every rule below it.
    const refused = evaluateDispatchRef('refs/heads/feat/whatever');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('refs/heads/main');
  });

  it('refuses a tag, a pull-request ref and an empty ref', () => {
    for (const ref of ['refs/tags/v1.0.0', 'refs/pull/27/merge', '', 'main']) {
      expect(evaluateDispatchRef(ref)).toHaveLength(1);
    }
  });

  it('refuses `main` without a ref prefix, because a ref is not a branch name', () => {
    expect(evaluateDispatchRef('main')).toHaveLength(1);
  });
});

describe('a push run counts only when it came from the trusted branch', () => {
  it('accepts a push run whose head_branch is main', () => {
    expect(isSuccessfulGateRun(run({ head_branch: 'main' }), SHA)).toBe(true);
  });

  it('refuses a push run from another branch, even on the same commit object', () => {
    // A green run on a feature branch is not the gate on main. Accepting it would
    // let a commit be deployed on a run that never tested the merge.
    expect(isSuccessfulGateRun(run({ head_branch: 'feat/thing' }), SHA)).toBe(false);
  });
});

/**
 * Ancestry, and the direction of the compare answer.
 *
 * The first version of this rule asked `compare/main...<sha>` and accepted
 * `ahead`, which is the *unmerged* case: it accepted exactly the commits it meant
 * to refuse. The URL and the reading are therefore both asserted, because a
 * fixture that returns `ahead` is consistent with either mistake.
 */
describe('readComparison', () => {
  it('treats `ahead` as merged, because main is the head of the comparison', () => {
    const reading = readComparison('ahead', SHA);
    expect(reading.onRef).toBe(true);
    expect(reading.detail).toContain("in main's history");
  });

  it('treats `identical` as the tip of main', () => {
    expect(readComparison('identical', SHA).onRef).toBe(true);
  });

  it('refuses `behind`, which means the requested commit is ahead of main', () => {
    const reading = readComparison('behind', SHA);
    expect(reading.onRef).toBe(false);
    expect(reading.detail).toContain('not merged');
  });

  it('refuses `diverged`, where neither side contains the other', () => {
    expect(readComparison('diverged', SHA).onRef).toBe(false);
  });

  it('refuses a missing, empty or unknown status rather than guessing', () => {
    for (const status of [null, undefined, '', '   ', 'unknown', 'AHEAD']) {
      const reading = readComparison(status, SHA);
      expect(reading.onRef).toBe(false);
    }
    expect(readComparison(null, SHA).detail).toContain('could not be established');
  });
});
