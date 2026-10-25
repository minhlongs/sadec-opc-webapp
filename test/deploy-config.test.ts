import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The configuration the deploy command actually reads.
 *
 * `scripts/deploy-preview.ts` runs `wrangler deploy --env pilot`, and that reads
 * the config the Cloudflare Vite plugin generates at `dist/sadec_flow/wrangler.json`
 * — not `wrangler.jsonc`. The plugin's generated file is what a deployment gets,
 * so this test asserts on it rather than on the source config, which is the
 * difference between a passing check and a working deploy.
 *
 * The file is a build artifact, so this test needs `pnpm build` to have run. A run
 * without a build is a failure that says so, rather than a pass that proves
 * nothing.
 */
interface GeneratedBinding {
  binding?: unknown;
  database_name?: unknown;
}

interface GeneratedEnvironment {
  name?: unknown;
  vars?: { APP_ENV?: unknown };
  d1_databases?: GeneratedBinding[];
}

interface GeneratedConfig {
  name?: unknown;
  definedEnvironments?: unknown;
  assets?: { run_worker_first?: unknown };
  d1_databases?: GeneratedBinding[];
}

const GENERATED_CONFIG = join(
  process.cwd(),
  'dist',
  'sadec_flow',
  'wrangler.json',
);

function generatedConfig(): GeneratedConfig {
  try {
    return JSON.parse(readFileSync(GENERATED_CONFIG, 'utf8')) as GeneratedConfig;
  } catch (thrown) {
    // A missing build is a broken check, not a green one.
    throw new Error(
      `The deploy config at ${GENERATED_CONFIG} could not be read: ${String(thrown)}. Run pnpm build first.`,
    );
  }
}

function bindingNames(config: GeneratedConfig): string[] {
  return (config.d1_databases ?? []).map((entry: GeneratedBinding) =>
    String(entry.binding ?? ''),
  );
}

describe('the deploy configuration carries the pilot database', () => {
  /**
   * The defect this file exists to catch: the generated config declared
   * `definedEnvironments: ["pilot"]` while emitting no `env.pilot`, so the deploy
   * resolved no `sadec_pilot` binding and no `APP_ENV`. Every guarded route then
   * refused on a pilot Worker that had passed every local gate and every unit
   * test, because the tests inject their own binding.
   */
  it('resolves a binding the pilot deployment can read', () => {
    const config = generatedConfig();
    expect(bindingNames(config)).toContain('sadec_pilot');
  });

  it('keeps the local and test databases apart from the pilot one', () => {
    // §3's separation: local has the demo and test databases, pilot has its own,
    // and neither inherits from the other.
    const config = generatedConfig();
    const bindings = bindingNames(config);
    expect(bindings).toEqual(['sadec_demo', 'sadec_test', 'sadec_test_restore', 'sadec_pilot']);
    // The pilot database must not be the demo one under a different name.
    expect(bindings.filter((name) => name === 'sadec_pilot')).toHaveLength(1);
  });

  it('routes API requests into the Worker', () => {
    // `run_worker_first` is routing, not security, but without it every /api/*
    // request falls through to the asset router and returns index.html — which
    // looks exactly like a missing route.
    const config = generatedConfig();
    const runFirst = (config.assets as { run_worker_first?: unknown } | undefined)
      ?.run_worker_first;
    expect(runFirst).toEqual(['/api/*']);
  });
});
