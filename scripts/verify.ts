#!/usr/bin/env node
/**
 * The single verification command. §15 requires that a run reporting zero tests
 * be treated as a failure, not a pass, and that no case is marked PASS for a
 * check that did not run.
 *
 * A plain `exit 0` is not evidence. This script runs the gates, reads their
 * output, and fails loudly when a gate passed vacuously — the exact failure
 * where a linter runs the wrong directory, reports nothing, and everyone
 * believes the tree is green.
 */

import { spawnSync } from 'node:child_process';
import { parseFileCount, parseTestCount } from './verify-summary.ts';

/**
 * The floor below which a green test run is treated as vacuous rather than
 * passing. The suite carries more than this from the first phase onward, so a
 * run under the floor means tests were lost, not that the project is small.
 */
const MINIMUM_TESTS = 20;

// Every gate that runs must be one that exists. A declared command that cannot
// run — eslint not installed, or an e2e runner that picks up another suite — is
// worse than one that is absent, because it makes the tree look covered. So the
// e2e gate is included, and its own config pins the app's browser tests.
// `build` runs before `test` because one test asserts on the deploy config the
// build generates (`test/deploy-config.test.ts` reads `dist/sadec_flow/wrangler.json`).
// With the old order a clean clone failed its first `pnpm verify` and passed
// every run after it — the gate depended on a leftover artifact, which is the
// kind of green nobody should trust.
const GATES = [
  { name: 'typecheck', packageScript: 'typecheck' },
  { name: 'build', packageScript: 'build' },
  { name: 'test', packageScript: 'test' },
];

/**
 * Runs a package script through pnpm, so the binaries this project depends on
 * resolve the same way they do for an operator typing `pnpm test`.
 */
function run(packageScript: string) {
  const result = spawnSync('pnpm', [packageScript], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    // The counts are read from the captured text, so colour is noise here.
    // The parser strips escapes anyway; asking for none is the first line of
    // defence, and keeps the captured output readable when a gate fails.
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** One gate's outcome, including the counts that prove it ran. */
interface GateResult {
  name: string;
  status: number;
  files: number | null;
  tests: number | null;
  detail: string;
}

const results: GateResult[] = [];
let failed = false;

for (const gate of GATES) {
  const runResult = run(gate.packageScript);
  const record: GateResult = {
    name: gate.name,
    status: runResult.status,
    files: null,
    tests: null,
    detail: '',
  };

  if (gate.name === 'test') {
    record.tests = parseTestCount(runResult.output);
    record.files = parseFileCount(runResult.output);
  }

  // A green exit proves nothing when nothing ran, or when almost nothing ran.
  if (gate.name === 'test' && runResult.status === 0) {
    if (record.tests === null || record.tests < MINIMUM_TESTS) {
      record.status = 1;
      record.detail =
        record.tests === null
          ? 'the test run reported no test count at all, which is a failure rather than a pass'
          : `only ${record.tests} test(s) ran, below the floor of ${MINIMUM_TESTS} — a suite this thin is a gate that passed vacuously`;
    }
    if (record.files !== null && record.files === 0) {
      record.status = 1;
      record.detail = 'no test files were collected at all';
    }
  }

  results.push(record);
  if (record.status !== 0) failed = true;
}

for (const record of results) {
  const mark = record.status === 0 ? 'PASS' : 'FAIL';
  const counts =
    record.tests === null
      ? ''
      : ` — ${record.tests} tests across ${record.files ?? '?'} files`;
  process.stdout.write(`${mark}  ${record.name}${counts}\n`);
  if (record.detail) process.stdout.write(`      ${record.detail}\n`);
  if (record.status !== 0) {
    process.stdout.write(`      exit status ${record.status}\n`);
  }
}

if (failed) {
  process.stdout.write('\nverify FAILED. A green exit with no tests run is not a pass.\n');
  process.exit(1);
}

process.stdout.write('\nverify passed. Gates above report real counts.\n');
