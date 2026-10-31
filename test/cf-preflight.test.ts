import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_PATH,
  EXPECTED_ACCOUNT_ID,
  PILOT_BINDING,
  databaseIdFor,
  evaluatePreflight,
  parseJsonc,
  stripLineComments,
  type PreflightFacts,
  type Probe,
} from '../scripts/preflight-facts.ts';

/**
 * The preflight decides whether a token is pointed at the right account, database
 * and Worker. It cannot be run here — this sandbox has no Cloudflare route — so
 * the decision is tested against facts, and the one part that reads the
 * repository's own config is tested against that config file.
 *
 * The failure this guards is the round-16 one: a deploy succeeded against the
 * wrong target and every route refused. A preflight that passed there would have
 * been worse than none, so each "wrong target" case below is a FAIL.
 */

function facts(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    accountId: EXPECTED_ACCOUNT_ID,
    tokenPresent: true,
    expectedDatabaseId: '5d2bd39f-93c0-400b-8207-586e17023cf2',
    account: { readable: true, id: EXPECTED_ACCOUNT_ID, detail: 'the token can read account "x"' },
    database: { found: true, id: '5d2bd39f-93c0-400b-8207-586e17023cf2', detail: '' },
    worker: { state: 'absent', detail: '' },
    access: { teamDomain: true, aud: true },
    ...overrides,
  };
}

function failures(probes: readonly Probe[]): Probe[] {
  return probes.filter((probe) => probe.state === 'FAIL');
}

describe('stripLineComments', () => {
  it('removes whole-line comments and leaves values alone', () => {
    const stripped = stripLineComments('{\n  // a comment\n  "a": 1\n}\n');
    expect(stripped).not.toContain('//');
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
  });

  it('does not treat a // inside a string value as a comment', () => {
    const stripped = stripLineComments('{\n  "url": "https://example.test/x"\n}\n');
    expect(JSON.parse(stripped)).toEqual({ url: 'https://example.test/x' });
  });
});

describe('parseJsonc', () => {
  it('tolerates the trailing comma wrangler.jsonc actually ends with', () => {
    // The real file's last property is `"d1_databases": [...],` followed by `}`.
    // Strict JSON refuses that, and a preflight reading the real config has to
    // read it the way wrangler does.
    expect(parseJsonc('{\n  // note\n  "a": [1],\n}\n')).toEqual({ a: [1] });
  });

  it('still refuses a config that is broken rather than commented', () => {
    expect(() => parseJsonc('{ "a": }')).toThrow();
  });
});

describe('databaseIdFor', () => {
  it('finds the id this repository binds sadec_pilot to', () => {
    const source = readFileSync(CONFIG_PATH, 'utf8');
    const id = databaseIdFor(source, PILOT_BINDING);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns null for a binding the config does not declare', () => {
    const source = readFileSync(CONFIG_PATH, 'utf8');
    expect(databaseIdFor(source, 'sadec_does_not_exist')).toBeNull();
  });

  it('returns null rather than throwing on a config that is not JSONC', () => {
    expect(databaseIdFor('not a config', PILOT_BINDING)).toBeNull();
    expect(databaseIdFor('{"d1_databases": "nope"}', PILOT_BINDING)).toBeNull();
  });
});

describe('evaluatePreflight', () => {
  it('passes a token that can see the expected account, database and Worker', () => {
    const probes = evaluatePreflight(facts({ worker: { state: 'present', detail: '' } }));
    expect(failures(probes)).toEqual([]);
    expect(probes.map((probe) => probe.state)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  });

  it('treats a first deploy — no Worker yet — as information, not a failure', () => {
    const probes = evaluatePreflight(facts({ worker: { state: 'absent', detail: '' } }));
    expect(failures(probes)).toEqual([]);
    expect(probes.find((probe) => probe.name.startsWith('worker'))?.state).toBe('INFO');
  });

  it('fails when the token cannot read the account', () => {
    const probes = evaluatePreflight(
      facts({ account: { readable: false, id: null, detail: 'the API answered 403.' } }),
    );
    const failed = failures(probes);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.name).toBe('account access');
    expect(failed[0]?.detail).toContain('Account:Read');
  });

  it('fails when the named account is not the account the config belongs to', () => {
    const probes = evaluatePreflight(facts({ accountId: 'f'.repeat(32) }));
    expect(failures(probes).map((probe) => probe.name)).toEqual(['account id']);
  });

  it('fails when the token is missing, without querying anything', () => {
    const probes = evaluatePreflight(
      facts({ tokenPresent: false, account: { readable: false, id: null, detail: 'not checked' } }),
    );
    expect(failures(probes).map((probe) => probe.name)).toContain('token');
  });

  it('fails when no database with the pilot name is visible', () => {
    const probes = evaluatePreflight(facts({ database: { found: false, id: null, detail: 'none' } }));
    const failed = failures(probes);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain('none');
  });

  it('fails when the pilot database id is not the id the config binds', () => {
    // The round-16 shape: a database with the right name and the wrong identity.
    const probes = evaluatePreflight(
      facts({ database: { found: true, id: '00000000-0000-0000-0000-000000000000', detail: '' } }),
    );
    const failed = failures(probes);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.name).toBe('database sadec-pilot');
    expect(failed[0]?.detail).toContain('would bind the wrong database');
  });

  it('fails when the config binds no id for the binding at all', () => {
    const probes = evaluatePreflight(facts({ expectedDatabaseId: null }));
    expect(failures(probes).map((probe) => probe.name)).toEqual(['database sadec-pilot']);
  });

  it('fails when either Access value is empty, naming the one that is', () => {
    const teamDomainOnly = failures(
      evaluatePreflight(facts({ access: { teamDomain: true, aud: false } })),
    );
    expect(teamDomainOnly).toHaveLength(1);
    expect(teamDomainOnly[0]?.detail).toContain('ACCESS_AUD');

    const auditOnly = failures(evaluatePreflight(facts({ access: { teamDomain: false, aud: true } })));
    expect(auditOnly[0]?.detail).toContain('ACCESS_TEAM_DOMAIN');

    const neither = failures(evaluatePreflight(facts({ access: { teamDomain: false, aud: false } })));
    expect(neither[0]?.detail).toContain('ACCESS_TEAM_DOMAIN and ACCESS_AUD');
  });

  it('does not print a token or an audience value in any probe detail', () => {
    const probes = evaluatePreflight(facts({ access: { teamDomain: false, aud: false } }));
    for (const probe of probes) {
      expect(probe.detail).not.toMatch(/eyJ/); // the shape of a JWT
      expect(probe.detail.toLowerCase()).not.toContain('bearer ');
    }
  });
});
