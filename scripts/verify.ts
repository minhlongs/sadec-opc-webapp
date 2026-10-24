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

/**
 * The floor below which a green test run is treated as vacuous rather than
 * passing. The suite carries more than this from the first phase onward, so a
 * run under the floor means tests were lost, not that the project is small.
 */
const MINIMUM_TESTS = 20;

const GATES = [
  { name: 'typecheck', packageScript: 'typecheck' },
  { name: 'test', packageScript: 'test' },
  { name: 'build', packageScript: 'build' },
];

/** Reads the number of tests a vitest run actually executed. */
function parseTestCount(output) {
  // "Tests  35 passed (35)"
  const summary = output.match(/Tests\s+([\d,]+)\s+passed(?:.*?\(([\d,]+)\))?/);
  if (!summary) return null;
  return Number(summary[2] ?? summary[1]);
}

/** Reads the number of files a vitest run actually collected. */
function parseFileCount(output) {
  const summary = output.match(/Test Files\s+([\d,]+)\s+passed/);
  return summary ? Number(summary[1]) : null;
}

/**
 * Runs a package script through pnpm, so the binaries this project depends on
 * resolve the same way they do for an operator typing `pnpm test`.
 */
function run(packageScript) {
  const result = spawnSync('pnpm', [packageScript], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

const results = [];
let failed = false;

for (const gate of GATES) {
  const runResult = run(gate.packageScript);
  const record = {
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
