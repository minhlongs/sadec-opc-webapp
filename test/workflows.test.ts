import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The hygiene rules the workflows have to keep.
 *
 * These are not style checks. Each one is a property that has been asked for
 * explicitly and that is easy to break silently in a later edit — an unpinned
 * action, a write-scoped token, a `push` trigger on a workflow that holds deploy
 * secrets, a shell block that does not parse. A workflow only runs when somebody
 * dispatches it, so a mistake here is found at the worst moment; a test is the
 * cheapest place to find it instead.
 *
 * The YAML is read as text, not parsed. A parser would be a dependency, and the
 * rules below are about *lines* — a `uses:` value, a `permissions:` block, a shell
 * script — which text finds exactly. What text cannot check is checked by running
 * `bash -n` over every `run:` block, so a syntax error in a script that has never
 * been executed here still fails a test rather than a deployment.
 */

const WORKFLOWS = '.github/workflows';
const VERIFY = 'verify.yml';

/** The ops workflows, which are dispatched by hand and hold the pilot secrets. */
const OPS = [
  'deploy-pilot.yml',
  'smoke-pilot.yml',
  'db-backup-pilot.yml',
  'db-migrate-pilot.yml',
  'ops-preflight-pilot.yml',
  'bootstrap-founder-pilot.yml',
];

function read(name: string): string {
  return readFileSync(join(WORKFLOWS, name), 'utf8');
}

/**
 * The workflow with its comment lines removed.
 *
 * These files are heavily commented on purpose, and a comment saying "never
 * `cat .dev.vars`" must not itself trip the rule that forbids it. Every check
 * about *commands* reads this; checks about structure read the whole file.
 */
function code(name: string): string {
  return read(name)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * Extracts every `run:` body — the inline form and the block form — so it can be
 * handed to `bash -n`.
 *
 * The block form ends at the first non-empty line indented no further than the
 * `run:` key itself, which is how YAML block scalars terminate.
 */
function runBlocks(source: string): string[] {
  const lines = source.split('\n');
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    if (current === undefined) continue;
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(current);
    if (match === null) continue;

    const indent = (match[1] ?? '').length;
    const inline = (match[2] ?? '').trim();
    if (inline !== '' && inline !== '|' && inline !== '|-' && inline !== '>' && inline !== '>-') {
      blocks.push(inline);
      continue;
    }

    const collected: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line === undefined) break;
      if (line.trim() === '') {
        collected.push('');
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) break;
      collected.push(line);
    }

    const nonEmpty = collected.filter((line) => line.trim() !== '');
    if (nonEmpty.length > 0) {
      const dedent = Math.min(...nonEmpty.map((line) => line.length - line.trimStart().length));
      blocks.push(
        collected.map((line) => (line.trim() === '' ? '' : line.slice(dedent))).join('\n'),
      );
    }
    index = cursor - 1;
  }

  return blocks;
}

describe('the workflow directory', () => {
  it('holds the gate and every operational path as its own file', () => {
    const names = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));
    expect(names).toContain(VERIFY);
    for (const name of OPS) expect(names, `${name} is missing`).toContain(name);
    // A guard against the check itself passing vacuously.
    expect(names.length).toBeGreaterThanOrEqual(OPS.length + 1);
  });
});

describe.each([VERIFY, ...OPS])('%s', (name) => {
  const source = read(name);

  it('is pinned: every action is a commit SHA, never a tag', () => {
    const uses = [...source.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      expect(reference, `${reference} is not pinned to a full commit SHA`).toMatch(
        /^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+([/][A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/,
      );
    }
  });

  it('asks for read permission only', () => {
    expect(source).toMatch(/^permissions:/m);
    expect(source).toMatch(/^\s+contents:\s*read$/m);
    expect(source).not.toMatch(/:\s*write/);
    expect(source).not.toMatch(/write-all/);
  });

  it('never prints the environment, traces the shell, or reads local secrets', () => {
    // Comments are excluded: they discuss these patterns in order to forbid them.
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
    const blocks = runBlocks(source);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      // The Actions expression syntax is not bash. Substituting a bare word keeps
      // the quoting structure — and is what makes `bash -n` meaningful here.
      const shell = block.replace(/\$\{\{[^}]*\}\}/g, 'EXPR');
      const checked = spawnSync('bash', ['-n'], { input: shell, encoding: 'utf8' });
      expect(checked.status, `${name} has a shell block that does not parse:\n${shell}`).toBe(0);
    }
  });
});

describe('triggers and scopes', () => {
  it('deploys, migrates, backs up and bootstraps only when dispatched by hand', () => {
    for (const name of OPS) {
      const source = read(name);
      expect(source, `${name} must be manually dispatched`).toMatch(/^\s{2}workflow_dispatch:/m);
      expect(source, `${name} must not run on a push`).not.toMatch(/^\s{2}push:/m);
      expect(source, `${name} must not run on a pull request`).not.toMatch(/^\s{2}pull_request:/m);
    }
  });

  it('keeps the gate the only workflow that runs on push and pull_request', () => {
    const source = read(VERIFY);
    expect(source).toMatch(/^\s{2}push:/m);
    expect(source).toMatch(/^\s{2}pull_request:/m);
  });

  it('never lets a workflow that touches a secret be reachable from a fork', () => {
    // The rule behind the rule: `pull_request` from a fork runs untrusted code
    // with no access to secrets, but `push` to a branch does, and neither belongs
    // in a file that names a secret. Stated separately so a future workflow cannot
    // add a `push` trigger and still pass by not mentioning `secrets.`.
    for (const name of OPS) {
      const source = read(name);
      if (source.includes('secrets.')) {
        expect(source, `${name} names a secret and must stay dispatch-only`).not.toMatch(
          /^\s{2}(push|pull_request):/m,
        );
      }
    }
  });
});

describe('the pilot operational workflows', () => {
  it.each(OPS)('%s takes its secrets from the pilot environment', (name) => {
    const source = read(name);
    expect(source, `${name} does not declare environment: pilot`).toMatch(/^\s{4}environment:\s*pilot$/m);
  });

  it.each(OPS)('%s serialises itself against the other pilot work', (name) => {
    const source = read(name);
    expect(source).toMatch(/^concurrency:/m);
    expect(source).toMatch(/^\s{2}group:\s*\S+$/m);
    // Cancelling a migration or a deploy halfway is worse than waiting.
    expect(source).toMatch(/^\s{2}cancel-in-progress:\s*false$/m);
  });

  it.each(OPS)('%s runs only a commit CI has proved, checked out by SHA', (name) => {
    const source = read(name);
    expect(source).toContain('pnpm require-main-sha -- --sha');
    expect(source, `${name} does not check out the named SHA`).toContain('ref: ${{ inputs.sha }}');
    // `github.sha` is the branch tip, which is not the commit that was proved.
    expect(source).not.toMatch(/ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
  });

  it.each(OPS)('%s bounds its own run time', (name) => {
    expect(read(name)).toMatch(/^\s{4}timeout-minutes:\s*\d+$/m);
  });
});

describe('the database commands keep their guards', () => {
  // The workflows that run a guarded command. `smoke-pilot` and
  // `ops-preflight-pilot` run none: they read a URL and an API, and listing them
  // here would make the check half-vacuous for the files that matter.
  const RUNS_GUARDED = [
    'deploy-pilot.yml',
    'db-backup-pilot.yml',
    'db-migrate-pilot.yml',
    'bootstrap-founder-pilot.yml',
  ];

  it.each(RUNS_GUARDED)('%s names an environment on every database command', (name) => {
    const source = code(name);
    const guarded = [
      'pnpm db:backup',
      'pnpm db:migrate-pilot',
      'pnpm db:restore:drill',
      'pnpm bootstrap:founder',
      'pnpm deploy:preview',
    ];
    const lines = source.split('\n').filter((line) => guarded.some((command) => line.includes(command)));
    expect(lines.length, `${name} runs no guarded command`).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `"${line.trim()}" does not pass --env`).toContain('--env');
    }
  });

  it('confirms the pilot target by hand before writing to it', () => {
    for (const name of ['db-migrate-pilot.yml', 'bootstrap-founder-pilot.yml', 'deploy-pilot.yml']) {
      const source = read(name);
      expect(source, `${name} has no confirm input`).toMatch(/^\s{6}confirm:/m);
      expect(source, `${name} does not check the confirmation`).toContain('"$CONFIRM" != "sadec_pilot"');
    }
  });

  it('never passes --confirm to the migrate command from an input', () => {
    // The confirmation is a literal in the file, not something a dispatcher can
    // type differently: `--confirm ${{ ... }}` would make the guard decorative.
    const source = read('db-migrate-pilot.yml');
    expect(source).toContain('--confirm sadec_pilot');
    expect(source).not.toMatch(/--confirm\s+\$\{\{/);
  });
});

describe('artifacts', () => {
  it('uploads browser evidence only, and never a database export', () => {
    const uploaders = readdirSync(WORKFLOWS)
      .filter((name) => name.endsWith('.yml'))
      .filter((name) => read(name).includes('upload-artifact'));
    expect(uploaders).toEqual([VERIFY]);

    // A `backups/` path in the uploaded evidence would put an export in a general
    // artifact. The word may appear in a comment saying so; a path may not.
    const verify = read(VERIFY);
    expect(verify).not.toMatch(/^\s+backups/m);
    expect(code(VERIFY)).not.toContain('backups');
    for (const name of OPS) {
      expect(read(name), `${name} uploads an artifact`).not.toContain('upload-artifact');
    }
  });

  it('removes the pilot export from the runner after the drill', () => {
    const backup = read('db-backup-pilot.yml');
    expect(backup).toContain('rm -rf backups');
    // The drill is given the file this job wrote, explicitly.
    expect(backup).toContain('pnpm db:restore:drill -- --env pilot --file "$BACKUP"');
  });
});
