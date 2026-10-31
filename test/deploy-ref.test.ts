import { describe, expect, it } from 'vitest';
import {
  evaluateDeployRef,
  isSuccessfulGateRun,
  parseSha,
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

  it('accepts a successful workflow_dispatch run, which is how a re-run reports', () => {
    expect(isSuccessfulGateRun(run({ event: 'workflow_dispatch' }), SHA)).toBe(true);
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
    const text = summariseRuns([run({ event: 'pull_request', conclusion: 'failure' })]);
    expect(text).toContain('pull_request/completed/failure');
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
    const failures = evaluateDeployRef({ requested: SHA, ref: 'main', onRef: false, runs: [run()] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('is not on origin/main');
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
    expect(failures[0]).toContain('push/completed/failure');
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
