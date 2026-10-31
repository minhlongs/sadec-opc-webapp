import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * The properties the workflows have to keep, checked against the real files.
 *
 * The first group is the trust boundary, and it is the reason this file was
 * rewritten: the previous version asserted that each workflow ran
 * `pnpm require-main-sha` *after* checking out the requested commit — which meant
 * the tree being approved supplied the approver. Each assertion below fails if
 * that regression comes back.
 *
 * The rest are the rules that are easy to break silently in a later edit: an
 * unpinned action, a write-scoped token, a `push` trigger on a file that names a
 * secret, a missing lock, a shell block that does not parse.
 *
 * The YAML is parsed with `yaml`, because these checks are about structure — which
 * job declares the environment, which job needs which output. Text matching would
 * pass on a file whose indentation had moved the step into the wrong job, which is
 * exactly the mistake that matters here. Shell bodies are additionally run through
 * `bash -n`, since a parser can prove the YAML is valid and not that the script is.
 */

const WORKFLOWS = '.github/workflows';
const VERIFY = 'verify.yml';

/** Workflows that change the pilot. They share one lock and need a verified SHA. */
const MUTATING = ['deploy-pilot.yml', 'db-backup-pilot.yml', 'db-migrate-pilot.yml', 'bootstrap-founder-pilot.yml'];
/** Read-only workflows, which still refuse an unverified commit. */
const READ_ONLY = ['smoke-pilot.yml', 'ops-preflight-pilot.yml'];
const OPS = [...MUTATING, ...READ_ONLY];

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  if?: string;
}

interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      environment?: string;
      needs?: string | string[];
      outputs?: Record<string, string>;
      steps?: Step[];
      'timeout-minutes'?: number;
    }
  >;
}

function source(name: string): string {
  return readFileSync(join(WORKFLOWS, name), 'utf8');
}

function workflow(name: string): Workflow {
  return YAML.parse(source(name)) as Workflow;
}

/** The workflow with its comment lines removed: what actually executes. */
function code(name: string): string {
  return source(name)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** Every `run:` body, so it can be handed to `bash -n`. */
function runBlocks(name: string): string[] {
  const blocks: string[] = [];
  for (const job of Object.values(workflow(name).jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string') blocks.push(step.run);
    }
  }
  return blocks;
}

describe('the workflow directory', () => {
  it('holds the gate and every operational path as its own file', () => {
    const names = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));
    expect(names).toContain(VERIFY);
    for (const name of OPS) expect(names, `${name} is missing`).toContain(name);
    expect(names.length).toBeGreaterThanOrEqual(OPS.length + 1);
  });

  it('parses every file, so an indentation mistake fails here and not mid-deploy', () => {
    for (const name of readdirSync(WORKFLOWS).filter((entry) => entry.endsWith('.yml'))) {
      expect(() => workflow(name), `${name} is not valid YAML`).not.toThrow();
    }
  });
});

describe('the trust boundary', () => {
  it.each(OPS)('%s decides the commit in a job that holds no secret', (name) => {
    const document = workflow(name);
    const verifier = document.jobs?.['verify-target'];
    expect(verifier, `${name} has no verify-target job`).toBeDefined();
    // No `environment:` means no environment secrets; and the job must not name
    // one either, or the decision would run with the credentials it is gating.
    expect(verifier?.environment).toBeUndefined();
    const text = JSON.stringify(verifier);
    expect(text).not.toContain('secrets.');
    expect(text).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(text).not.toContain('R2');
  });

  it.each(OPS)('%s verifies from the trusted branch, not from the commit under test', (name) => {
    const verifier = workflow(name).jobs?.['verify-target'];
    const checkout = verifier?.steps?.find((step) => step.uses?.startsWith('actions/checkout'));
    expect(checkout, `${name}: the verifier does not check anything out`).toBeDefined();
    expect(checkout?.with?.ref, `${name}: the verifier must check out main`).toBe('main');
    // The requested SHA reaches the verifier only as an argument to the decision,
    // never as something it checks out or executes.
    expect(JSON.stringify(checkout)).not.toContain('inputs.sha');
    expect(JSON.stringify(verifier)).not.toMatch(/"ref":"\$\{\{\s*inputs\.sha/);
  });

  it.each(OPS)('%s runs the verifier command with the dispatch ref, so a branch dispatch is refused', (name) => {
    const verifier = workflow(name).jobs?.['verify-target'];
    const step = verifier?.steps?.find((entry) => entry.run?.includes('verify-target-sha'));
    expect(step, `${name} does not run verify-target-sha`).toBeDefined();
    expect(step?.run).toContain('--dispatch-ref "$DISPATCH_REF"');
    // The input arrives through `env:`, never spliced into the command line.
    expect(step?.env?.SHA).toBe('${{ inputs.sha }}');
    expect(step?.env?.DISPATCH_REF).toBe('${{ github.ref }}');
    expect(step?.run).not.toContain('${{');
  });

  it.each(OPS)('%s gives the credential-holding job only the verified output', (name) => {
    const document = workflow(name);
    const verifier = document.jobs?.['verify-target'];
    expect(verifier?.outputs?.sha).toBe('${{ steps.target.outputs.sha }}');

    const execute = Object.entries(document.jobs ?? {}).find(([id]) => id !== 'verify-target');
    expect(execute, `${name} has no second job`).toBeDefined();
    const [id, job] = execute as [string, NonNullable<Workflow['jobs']>[string]];
    expect(job.needs, `${name}: ${id} does not need verify-target`).toBe('verify-target');
    expect(job.environment, `${name}: ${id} must run in the pilot environment`).toBe('pilot');

    const checkout = job.steps?.find((step) => step.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.ref).toBe('${{ needs.verify-target.outputs.sha }}');
    // The operator's raw input must not reach this job's checkout.
    expect(JSON.stringify(checkout)).not.toContain('inputs.sha');
    expect(JSON.stringify(checkout)).not.toContain('github.sha');
  });

  it.each(OPS)('%s refuses to continue when no SHA was published', (name) => {
    // An empty `ref:` makes the checkout fall back to the triggering ref, which is
    // the one path that would bypass the decision entirely.
    const execute = Object.values(workflow(name).jobs ?? {}).find(
      (job) => job.environment === 'pilot',
    );
    const guard = execute?.steps?.[0];
    expect(guard?.run).toContain('${#VERIFIED}');
    expect(guard?.env?.VERIFIED).toBe('${{ needs.verify-target.outputs.sha }}');
  });

  it.each(OPS)('%s cannot be run from a branch or a tag', (name) => {
    // GitHub runs the workflow file from the selected ref, so a dispatch from
    // anywhere but main executes that ref's copy of every rule above.
    const document = workflow(name);
    expect(Object.keys(document.on ?? {})).toEqual(['workflow_dispatch']);
  });

  it('does not rely on pinning actions to protect a script from an arbitrary checkout', () => {
    // Pinning fixes *which* action runs. It says nothing about the repository code
    // a job then executes, which is why the verifier checks out main and the
    // execute job only ever sees a SHA the verifier approved.
    for (const name of OPS) {
      const verifier = JSON.stringify(workflow(name).jobs?.['verify-target']);
      expect(verifier).not.toContain('uses: ./');
    }
  });
});

describe.each([VERIFY, ...OPS])('%s', (name) => {
  const document = workflow(name);

  it('is pinned: every action is a commit SHA, or a local action in this repository', () => {
    const uses = [...source(name).matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map((match) => match[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      if (reference.startsWith('./')) continue; // this repository's own action
      expect(reference, `${reference} is not pinned to a full commit SHA`).toMatch(
        /^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+([/][A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/,
      );
    }
  });

  it('asks for read permission only', () => {
    expect(document.permissions?.contents).toBe('read');
    for (const value of Object.values(document.permissions ?? {})) {
      expect(value).toBe('read');
    }
    expect(source(name)).not.toMatch(/:\s*write/);
    expect(source(name)).not.toMatch(/write-all/);
  });

  it('never prints the environment, traces the shell, or reads local secrets', () => {
    const commands = code(name);
    const forbidden: [RegExp, string][] = [
      [/set\s+-[a-z]*x[a-z]*/, 'shell tracing (set -x)'],
      [/\bprintenv\b/, 'printenv'],
      [/\bACTIONS_STEP_DEBUG\b/, 'ACTIONS_STEP_DEBUG'],
      [/--debug\b/, '--debug'],
      [/\.dev\.vars/, '.dev.vars'],
      [/echo[^\n]*\$\{\{\s*secrets\./, 'echoing a secret'],
      [/pull_request_target/, 'pull_request_target'],
    ];
    for (const [pattern, what] of forbidden) {
      expect(pattern.test(commands), `${name} contains ${what}`).toBe(false);
    }
  });

  it('has a shell block that parses', () => {
    const blocks = runBlocks(name);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      // Actions expressions are not bash; substituting a bare word keeps the
      // quoting structure, which is what `bash -n` needs to be meaningful.
      const shell = block.replace(/\$\{\{[^}]*\}\}/g, 'EXPR');
      const checked = spawnSync('bash', ['-n'], { input: shell, encoding: 'utf8' });
      expect(checked.status, `${name} has a shell block that does not parse:\n${shell}`).toBe(0);
    }
  });

  it('passes user input through the environment rather than into a command line', () => {
    for (const job of Object.values(document.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        // `${{ inputs.x }}` inside a run block is string interpolation by the
        // workflow engine into a shell script: quoting becomes the operator's
        // problem. Values belong in `env:`.
        expect(step.run, `${name}: a run block interpolates an input`).not.toMatch(/\$\{\{\s*inputs\./);
      }
    }
  });
});

describe('the pilot lock', () => {
  it('serialises every mutating workflow against the others, not one group each', () => {
    const groups = new Set(MUTATING.map((name) => workflow(name).concurrency?.group));
    expect(groups.size, `mutating workflows use ${[...groups].join(', ')}`).toBe(1);
    for (const name of MUTATING) {
      // Cancelling a migration or a deploy halfway leaves a state nobody described.
      expect(workflow(name).concurrency?.['cancel-in-progress']).toBe(false);
    }
  });

  it('keeps the read-only workflows out of the mutating lock', () => {
    for (const name of READ_ONLY) {
      const group = workflow(name).concurrency?.group;
      const mutating = workflow(MUTATING[0] as string).concurrency?.group;
      expect(group, `${name} must not queue behind migrations`).not.toBe(mutating);
      expect(workflow(name).concurrency?.['cancel-in-progress']).toBe(false);
    }
  });

  it('holds the lock for the whole run, not per job', () => {
    // `concurrency` is a workflow-level key: it covers the verifier and the execute
    // job together, so there is no gap between "checked" and "did it".
    for (const name of MUTATING) {
      expect(source(name)).toMatch(/^concurrency:/m);
      for (const job of Object.values(workflow(name).jobs ?? {})) {
        expect(JSON.stringify(job)).not.toContain('concurrency');
      }
    }
  });

  it('says in the file what the lock does not cover', () => {
    for (const name of MUTATING) {
      expect(source(name)).toContain('does not stop an operator running');
    }
  });
});

describe('the database commands keep their guards', () => {
  const RUNS_GUARDED = ['deploy-pilot.yml', 'db-backup-pilot.yml', 'db-migrate-pilot.yml', 'bootstrap-founder-pilot.yml'];

  it.each(RUNS_GUARDED)('%s names an environment on every guarded command', (name) => {
    // Commands may live in the workflow or in the composite backup action it
    // calls. Both are scanned, because moving a command into the action must not
    // move it out of this check.
    const commands =
      code(name) +
      '\n' +
      readFileSync('.github/actions/pilot-backup/action.yml', 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
    const guarded = [
      'pnpm db:backup',
      'pnpm db:migrate-pilot',
      'pnpm db:restore:drill',
      'pnpm bootstrap:founder',
      'pnpm deploy:preview',
    ];
    const lines = commands.split('\n').filter((line) => guarded.some((command) => line.includes(command)));
    expect(lines.length, `${name} runs no guarded command`).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `"${line.trim()}" does not pass --env`).toContain('--env');
    }
  });

  it('confirms the pilot target by hand before anything irreversible', () => {
    for (const name of ['db-migrate-pilot.yml', 'bootstrap-founder-pilot.yml', 'deploy-pilot.yml']) {
      expect(source(name), `${name} has no confirm input`).toMatch(/^\s{6}confirm:/m);
      expect(source(name), `${name} does not check the confirmation`).toContain('"$CONFIRM" != "sadec_pilot"');
    }
  });

  it('never passes --confirm from an input, which would make the guard decorative', () => {
    const migrate = code('db-migrate-pilot.yml');
    expect(migrate).toContain('--confirm sadec_pilot');
    expect(migrate).not.toMatch(/--confirm\s+\$/);
  });

  it('never accepts an object key, run id or receipt from the dispatcher', () => {
    // A typed key would be a claim. The migration makes its own backup and its own
    // receipt in the same run, under the same lock.
    for (const name of MUTATING) {
      const inputs = Object.keys((workflow(name).on?.workflow_dispatch as { inputs?: object })?.inputs ?? {});
      for (const forbidden of ['object_key', 'receipt', 'backup', 'run_id']) {
        expect(inputs, `${name} takes a "${forbidden}" input`).not.toContain(forbidden);
      }
    }
  });

  it('takes a backup before it migrates, in the same job', () => {
    const steps = workflow('db-migrate-pilot.yml').jobs?.migrate?.steps ?? [];
    const backup = steps.findIndex((step) => step.uses === './.github/actions/pilot-backup');
    const migrate = steps.findIndex((step) => step.run?.includes('pnpm db:migrate-pilot'));
    expect(backup).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(backup);
  });
});

describe('bootstrap inputs', () => {
  it('never asks for a token, a JWT or a password', () => {
    const inputs = Object.keys(
      ((workflow('bootstrap-founder-pilot.yml').on?.workflow_dispatch as { inputs?: object })?.inputs) ?? {},
    );
    for (const forbidden of ['token', 'jwt', 'password', 'secret', 'bearer']) {
      expect(inputs.some((input) => input.includes(forbidden))).toBe(false);
    }
  });

  it('says in the form that the subject and email are metadata', () => {
    const text = source('bootstrap-founder-pilot.yml');
    expect(text).toContain('metadata; visible in run logs');
  });

  it('writes only when the dispatcher declared the subject verified', () => {
    const steps = workflow('bootstrap-founder-pilot.yml').jobs?.bootstrap?.steps ?? [];
    const apply = steps.find((step) => step.run?.includes('--apply'));
    expect(apply?.if).toContain("inputs.subject_verified == 'yes'");
    // The script's own guard is still passed explicitly, not bypassed.
    expect(apply?.run).toContain('--subject-verified');
    const refusal = steps.find((step) => step.run?.includes('Only the preview ran'));
    expect(refusal?.if).toContain("!= 'yes'");
  });
});

describe('artifacts', () => {
  it('uploads browser evidence only, and never a database export', () => {
    const uploaders = readdirSync(WORKFLOWS)
      .filter((name) => name.endsWith('.yml'))
      .filter((name) => source(name).includes('upload-artifact'));
    expect(uploaders).toEqual([VERIFY]);

    expect(source(VERIFY)).not.toMatch(/^\s+backups/m);
    expect(code(VERIFY)).not.toContain('backups');
    for (const name of OPS) {
      expect(source(name), `${name} uploads an artifact`).not.toContain('upload-artifact');
    }
  });

  it('deletes the pilot export from the runner whatever happened', () => {
    for (const name of ['db-backup-pilot.yml', 'db-migrate-pilot.yml']) {
      const steps = Object.values(workflow(name).jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.run?.includes('rm -rf backups'));
      expect(steps.length, `${name} does not remove the export`).toBeGreaterThan(0);
      expect(steps[0]?.if).toBe('always()');
    }
  });
});

describe('the composite backup action', () => {
  const action = YAML.parse(readFileSync('.github/actions/pilot-backup/action.yml', 'utf8')) as {
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    runs: { steps: Step[] };
  };

  it('exports, drills, uploads, reads back and only then writes a receipt', () => {
    const order = action.runs.steps.map((step) => `${step.name ?? ''} ${step.run ?? ''}`);
    const index = (pattern: RegExp) => order.findIndex((entry) => pattern.test(entry));
    expect(index(/Export the pilot database/)).toBeLessThan(index(/Drill the export/));
    expect(index(/Drill the export/)).toBeLessThan(index(/Upload to the private bucket/));
    expect(index(/Upload to the private bucket/)).toBeLessThan(index(/Read the object back/));
    expect(index(/Read the object back/)).toBeLessThan(index(/Write the receipt/));
    expect(index(/Write the receipt/)).toBeLessThan(index(/Prove the receipt would satisfy a migration/));
  });

  it('fails when the stored object does not hash to the export', () => {
    const readback = action.runs.steps.find((step) => /Read the object back/.test(step.name ?? ''));
    expect(readback?.run).toContain('if [ "$readback_sha" != "$source_sha" ]');
  });

  it('talks to the remote bucket, never the local one', () => {
    // A `--local` upload succeeds, reads back, and hashes correctly — and stores
    // the only copy of the backup on the runner that is about to be deleted. The
    // whole point of this round is the object outliving the job, so every R2
    // command must name `--remote`; `--local` or silence fails here.
    const commands = action.runs.steps
      .flatMap((step) => (step.run ?? '').split('\n'))
      .map((line) => line.trim())
      .filter((line) => /wrangler r2 object (put|get)\b/.test(line));
    expect(commands.length).toBeGreaterThanOrEqual(2);
    for (const line of commands) {
      expect(line).toContain('--remote');
      expect(line).not.toContain('--local');
    }
  });

  it('never prints the export or uploads it as an artifact', () => {
    const text = JSON.stringify(action);
    expect(text).not.toContain('upload-artifact');
    expect(text).not.toContain('cat "$FILE"');
    expect(text).not.toContain('set -x');
  });
});
