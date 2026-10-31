import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_PATH,
  EXPECTED_ACCOUNT_ID,
  PILOT_BINDING,
  databaseIdFor,
  evaluatePreflight,
  summarise,
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
    // Four resource answers plus the Access-presence answer, then two `INFO`
    // lines: the Access *match* is not checked, and the bucket is not asked about
    // for a deploy.
    // Worker present is a PASS; the Access *match* is INFO because it was not
    // checked; no bucket question is asked for a deploy.
    expect(probes.map((probe) => probe.state)).toEqual([
      'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'INFO',
    ]);
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

describe('a Worker whose presence cannot be confirmed', () => {
  it('fails a deploy rather than reporting information', () => {
    // "Probably fine" is how a deployment lands somewhere nobody chose. A refused
    // or failed lookup is a refusal to write, not a note.
    const probes = evaluatePreflight(
      facts({ purpose: 'deploy', worker: { state: 'unknown', detail: 'the API answered 403.' } }),
    );
    const failed = failures(probes);
    expect(failed.map((probe) => probe.name)).toContain('worker sadec-flow-pilot');
    expect(failed.find((probe) => probe.name.startsWith('worker'))?.detail).toContain('Workers Scripts:Read');
  });

  it('does not block a backup or a migration, which touch the database, not the Worker', () => {
    for (const purpose of ['migrate', 'backup', 'bootstrap', 'inspect'] as const) {
      const probes = evaluatePreflight(
        facts({ purpose, worker: { state: 'unknown', detail: 'the API answered 500.' }, r2: r2Facts() }),
      );
      expect(failures(probes).map((probe) => probe.name)).not.toContain('worker sadec-flow-pilot');
    }
  });

  it('is only information when the purpose changes nothing', () => {
    const probes = evaluatePreflight(
      facts({ purpose: 'inspect', worker: { state: 'unknown', detail: 'the API answered 403.' } }),
    );
    expect(failures(probes)).toEqual([]);
    expect(probes.find((probe) => probe.name.startsWith('worker'))?.state).toBe('INFO');
  });

  it('keeps an absent Worker as information for a migration — the database is the target', () => {
    const probes = evaluatePreflight(facts({ purpose: 'migrate', worker: { state: 'absent', detail: '' }, r2: r2Facts() }));
    expect(failures(probes).map((probe) => probe.name)).not.toContain('worker sadec-flow-pilot');
    expect(probes.find((probe) => probe.name.startsWith('worker'))?.state).toBe('INFO');
  });
});

function r2Facts(overrides: Partial<NonNullable<PreflightFacts['r2']>> = {}) {
  return {
    bucket: 'present' as const,
    detail: '',
    publicAccess: 'none' as const,
    publicDetail: 'no managed domain is enabled',
    retentionDays: 30,
    retentionDetail: 'an expiry rule is configured.',
    lockDays: null,
    lockDetail: 'no bucket lock rule is enabled.',
    ...overrides,
  };
}

describe('the backup bucket', () => {
  const backup = (overrides: Partial<PreflightFacts> = {}) =>
    evaluatePreflight(facts({ purpose: 'backup', r2: r2Facts(), ...overrides }));

  it('passes a private bucket with 30-day retention', () => {
    expect(failures(backup())).toEqual([]);
  });

  it('fails when the bucket was never created, and says who decides', () => {
    const failed = failures(backup({ r2: r2Facts({ bucket: 'missing', detail: 'no bucket named x.' }) }));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain('approved the cost');
  });

  it('fails when the bucket could not be read, because an unknown is not a pass', () => {
    const failed = failures(backup({ r2: r2Facts({ bucket: 'unknown', detail: 'the API answered 403.' }) }));
    expect(failed).toHaveLength(1);
  });

  it('fails when the bucket is public through either switch', () => {
    for (const publicAccess of ['enabled', 'unknown'] as const) {
      const failed = failures(backup({ r2: r2Facts({ publicAccess, publicDetail: 'a domain is attached.' }) }));
      expect(failed.map((probe) => probe.name)).toContain('bucket is private');
    }
  });

  it('fails when no lifecycle rule expires objects', () => {
    const failed = failures(backup({ r2: r2Facts({ retentionDays: null }) }));
    expect(failed.map((probe) => probe.name)).toContain('bucket retention');
  });

  it('fails when retention is shorter than the design proposes', () => {
    const failed = failures(backup({ r2: r2Facts({ retentionDays: 7 }) }));
    expect(failed.map((probe) => probe.name)).toContain('bucket retention');
    expect(failed.find((probe) => probe.name === 'bucket retention')?.detail).toContain('shorter');
  });

  it('fails a backup whose bucket was never checked', () => {
    const failed = failures(evaluatePreflight(facts({ purpose: 'backup' })));
    expect(failed.map((probe) => probe.name)).toContain('bucket sadec-pilot-backups');
  });

  it('does not ask about the bucket for a deploy', () => {
    const names = evaluatePreflight(facts({ purpose: 'deploy' })).map((probe) => probe.name);
    expect(names.some((name) => name.startsWith('bucket '))).toBe(false);
  });
});

describe('resource preflight versus access login', () => {
  it('never reports a passing preflight as proof that someone can sign in', () => {
    const probes = evaluatePreflight(facts({ purpose: 'deploy' }));
    const lines = summarise(facts({ purpose: 'deploy' }), probes).join('\n');
    expect(lines).toContain('RESOURCE PREFLIGHT PASSED');
    expect(lines).toContain('ACCESS LOGIN NOT VERIFIED');
  });

  it('says the failure out loud when the resource preflight did not pass', () => {
    const broken = facts({ purpose: 'deploy', tokenPresent: false });
    const lines = summarise(broken, evaluatePreflight(broken)).join('\n');
    expect(lines).toContain('RESOURCE PREFLIGHT FAILED');
    expect(lines).toContain('ACCESS LOGIN NOT VERIFIED');
  });

  it('records that a non-empty secret does not prove the Worker matches', () => {
    const probe = evaluatePreflight(facts({ purpose: 'deploy' })).find(
      (entry) => entry.name === 'Access configuration matched',
    );
    expect(probe?.state).toBe('INFO');
    expect(probe?.detail).toContain('NOT CHECKED');
    expect(probe?.detail).toContain('wrangler secret list');
  });
});
