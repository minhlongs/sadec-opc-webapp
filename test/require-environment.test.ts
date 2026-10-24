import { describe, expect, it } from 'vitest';
import {
  bindingNameFor,
  COMMAND_ENVIRONMENTS,
  parseEnvironmentFlag,
  requireEnvironment,
} from '../scripts/require-environment.js';
import type { Environment } from '../scripts/require-environment.js';

/**
 * A stand-in for the Node process, so a refusal can be asserted without the test
 * killing its own runner.
 */
function fakeProcess(argv: readonly string[]) {
  /** Closure state, so a detached write or exit call still records itself. */
  const state = {
    exitCodes: [] as number[],
    stderr: [] as string[],
    stdout: [] as string[],
  };
  return {
    argv: ['node', 'script', ...argv],
    exit(code: number): never {
      state.exitCodes.push(code);
      throw new Error(`__exit_${code}__`);
    },
    stderr: {
      write: (chunk: string) => {
        state.stderr.push(chunk);
        return true;
      },
    },
    stdout: {
      write: (chunk: string) => {
        state.stdout.push(chunk);
        return true;
      },
    },
    /** Test-only readers, so the fake itself carries its own evidence. */
    exitCodes: () => [...state.exitCodes],
    wroteStderr: () => state.stderr.join(''),
    wroteStdout: () => state.stdout.join(''),
  };
}

const ENVIRONMENT_NAMES: readonly Environment[] = ['demo', 'test', 'pilot'];

describe('parseEnvironmentFlag', () => {
  it('reads an explicit environment', () => {
    expect(parseEnvironmentFlag(['--env', 'test'])).toBe('test');
    expect(parseEnvironmentFlag(['--env', 'pilot'])).toBe('pilot');
  });

  it('treats a missing flag as unspecified rather than guessing one', () => {
    expect(parseEnvironmentFlag([])).toBeNull();
    expect(parseEnvironmentFlag(['--verbose'])).toBeNull();
  });

  it('treats a flag with no value as unspecified', () => {
    expect(parseEnvironmentFlag(['--env'])).toBeNull();
    expect(parseEnvironmentFlag(['--env', '--other'])).toBeNull();
  });
});

describe('requireEnvironment', () => {
  it('accepts the named environment for a permitted command', () => {
    expect(requireEnvironment(fakeProcess(['--env', 'demo']), 'db:migrate:local')).toBe(
      'demo',
    );
    expect(requireEnvironment(fakeProcess(['--env', 'test']), 'db:migrate:local')).toBe(
      'test',
    );
  });

  it('refuses rather than guessing when no environment is given', () => {
    const proc = fakeProcess([]);
    expect(() => requireEnvironment(proc, 'db:backup')).toThrow(/__exit_2__/);
    expect(proc.exitCodes()).toEqual([2]);
    expect(proc.wroteStderr()).toMatch(/requires an explicit environment/i);
    // A refusal must not resolve an environment on the way out.
    expect(proc.wroteStdout()).toBe('');
  });

  it('refuses an environment the command does not accept', () => {
    const proc = fakeProcess(['--env', 'pilot']);
    // Restoring names only the test database, so pilot must be refused rather
    // than silently restoring over pilot data.
    expect(() => requireEnvironment(proc, 'db:restore:test')).toThrow(/__exit_2__/);
    expect(proc.exitCodes()).toEqual([2]);
    expect(proc.wroteStderr()).toMatch(/does not accept/i);
  });

  it('refuses an environment outside the known set entirely', () => {
    const proc = fakeProcess(['--env', 'production']);
    expect(() => requireEnvironment(proc, 'db:backup')).toThrow(/__exit_2__/);
    expect(proc.exitCodes()).toEqual([2]);
  });

  it('refuses a backup that names a database the command cannot target', () => {
    const proc = fakeProcess(['--env', 'staging']);
    expect(() => requireEnvironment(proc, 'deploy:preview')).toThrow(/__exit_2__/);
    expect(proc.exitCodes()).toEqual([2]);
  });

  it('seeds into the demo database and nothing else', () => {
    expect(COMMAND_ENVIRONMENTS['db:seed:demo']).toEqual(['demo']);
  });

  it('restores into the test database and nothing else', () => {
    expect(COMMAND_ENVIRONMENTS['db:restore:test']).toEqual(['test']);
  });

  it('migrates the pilot database with the command that is actually callable', () => {
    // The package script is named with a single colon, not two: pnpm reads a
    // second colon as a scope separator and never resolves the command. If this
    // key drifts from the script name again, the guard silently falls back to
    // accepting every environment, which is how a demo database ends up remote.
    expect(COMMAND_ENVIRONMENTS['db:migrate-pilot']).toEqual(['pilot']);
    expect(Object.keys(COMMAND_ENVIRONMENTS)).toContain('db:migrate-pilot');
    expect(Object.keys(COMMAND_ENVIRONMENTS)).not.toContain('db:migrate:pilot');
  });

  it('deploys the preview only from the pilot environment', () => {
    expect(COMMAND_ENVIRONMENTS['deploy:preview']).toEqual(['pilot']);
  });

  it('refuses every command whose guard key no longer matches its script name', () => {
    // A command missing from this map falls back to accepting every environment.
    // Every database-touching command must therefore be listed.
    for (const command of [
      'db:migrate:local',
      'db:seed:demo',
      'db:backup',
      'db:restore:test',
      'db:migrate-pilot',
      'deploy:preview',
    ]) {
      expect(COMMAND_ENVIRONMENTS[command], `${command} is unguarded`).toBeDefined();
    }
  });
});

describe('bindingNameFor', () => {
  it('names each environment distinctly', () => {
    expect(bindingNameFor('demo')).toBe('sadec_demo');
    expect(bindingNameFor('test')).toBe('sadec_test');
    expect(bindingNameFor('pilot')).toBe('sadec_pilot');
  });

  it('gives every environment a name of its own', () => {
    const names = ENVIRONMENT_NAMES.map(bindingNameFor);
    expect(new Set(names).size).toBe(ENVIRONMENT_NAMES.length);
  });
});
