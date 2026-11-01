import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_PATH,
  EXPECTED_ACCOUNT_ID,
  PILOT_BINDING,
  databaseIdFor,
  effectiveExpiry,
  effectiveLock,
  evaluatePreflight,
  readExpiryRules,
  readLockRules,
  summarise,
  parseJsonc,
  prefixCovers,
  stripLineComments,
  type ExpiryRule,
  type LockRule,
  type PreflightFacts,
  type Probe,
  type R2Facts,
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

/** A lifecycle rule in the flat shape the API returns. */
function expiry(prefix: string, days: number, id = `expire-${prefix || 'all'}`, enabled = true): ExpiryRule {
  return { id, prefix, enabled, days, unreadable: false };
}

/** A lifecycle rule that deletes objects but whose age could not be read. */
function unreadableExpiry(prefix: string, id = `expire-${prefix || 'all'}`): ExpiryRule {
  return { id, prefix, enabled: true, days: null, unreadable: true };
}

/** A lock rule, in days. */
function lock(prefix: string, days: number, id = `lock-${prefix || 'all'}`, enabled = true): LockRule {
  return { id, prefix, enabled, days, unreadable: false };
}

function unreadableLock(prefix: string, id = `lock-${prefix || 'all'}`): LockRule {
  return { id, prefix, enabled: true, days: null, unreadable: true };
}

function r2Facts(
  overrides: Partial<R2Facts> & {
    expiryRules?: readonly ExpiryRule[];
    lockRules?: readonly LockRule[];
  } = {},
): R2Facts {
  const {
    expiryRules = [expiry('pilot/', 30)],
    lockRules = [lock('pilot/', 30)],
    lifecycle,
    lock: lockSet,
    ...rest
  } = overrides;
  return {
    bucket: 'present',
    detail: '',
    publicAccess: 'none',
    publicDetail: 'no managed domain is enabled',
    lifecycle: lifecycle ?? {
      readable: true,
      detail: 'the lifecycle configuration lists rules.',
      rules: expiryRules,
    },
    lock: lockSet ?? { readable: true, detail: 'the lock configuration lists rules.', rules: lockRules },
    ...rest,
  };
}

describe('the backup bucket', () => {
  const backup = (overrides: Partial<PreflightFacts> = {}) =>
    evaluatePreflight(facts({ purpose: 'backup', r2: r2Facts(), ...overrides }));

  it('passes a private bucket with 30-day retention and a 30-day lock', () => {
    expect(failures(backup())).toEqual([]);
  });

  it('fails when no lock rule protects the export prefix', () => {
    // A unique key is not an immutable object: a write token can `put` the same
    // key and replace the bytes behind a receipt. Without a lock the run must stop,
    // not print an INFO line and carry on.
    const failed = failures(backup({ r2: r2Facts({ lockRules: [] }) }));
    expect(failed.map((probe) => probe.name)).toContain('bucket lock');
    expect(failed.find((probe) => probe.name === 'bucket lock')?.detail).toContain(
      'no enabled lock rule applies to pilot/',
    );
  });

  it('fails a lock shorter than the retention it is meant to outlast', () => {
    const failed = failures(backup({ r2: r2Facts({ lockRules: [lock('pilot/', 7)] }) }));
    expect(failed.map((probe) => probe.name)).toContain('bucket lock');
  });

  it('fails a lock scoped to a prefix the backups are not written under', () => {
    const failed = failures(backup({ r2: r2Facts({ lockRules: [lock('other/', 30)] }) }));
    expect(failed.map((probe) => probe.name)).toContain('bucket lock');
    expect(failed.find((probe) => probe.name === 'bucket lock')?.detail).toContain('other/');
  });

  it('fails retention when the expiry rule does not cover the export prefix', () => {
    const failed = failures(backup({ r2: r2Facts({ expiryRules: [expiry('elsewhere/', 30)] }) }));
    expect(failed.map((probe) => probe.name)).toContain('bucket retention');
    const detail = failed.find((probe) => probe.name === 'bucket retention')?.detail ?? '';
    expect(detail).toContain('no enabled lifecycle rule applies to pilot/');
    expect(detail).toContain('elsewhere/');
  });

  it('accepts a bucket-wide rule, which covers every prefix', () => {
    const probes = backup({ r2: r2Facts({ expiryRules: [expiry('', 30)], lockRules: [lock('', 30)] }) });
    expect(failures(probes)).toEqual([]);
  });

  it('notes when the expiry also deletes the receipts, which are the audit trail', () => {
    const probes = backup({ r2: r2Facts({ expiryRules: [expiry('', 30)] }) });
    const probe = probes.find((entry) => entry.name === 'receipts excluded from expiry');
    expect(probe?.state).toBe('INFO');
    expect(probe?.detail).toContain('receipts');
  });

  it('passes the receipt scope check when expiry is limited to the export prefix', () => {
    const probes = backup();
    const probe = probes.find((entry) => entry.name === 'receipts excluded from expiry');
    expect(probe?.state).toBe('PASS');
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
    const failed = failures(backup({ r2: r2Facts({ expiryRules: [] }) }));
    expect(failed.map((probe) => probe.name)).toContain('bucket retention');
  });

  it('fails when retention is shorter than the design proposes', () => {
    const failed = failures(backup({ r2: r2Facts({ expiryRules: [expiry('pilot/', 7)] }) }));
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

/**
 * The round-19 review found the preflight summarising the bucket's rules before it
 * judged them: the longest age went into one field and the prefixes into another.
 * A bucket with `pilot/` at 7 days and `other/` at 30 days therefore reported
 * "30-day expiry covers pilot/" — a green line about retention that did not exist,
 * and the same for the lock. These cases are the ones that would have caught it.
 */
describe('prefix and duration stay together', () => {
  const backup = (overrides: Partial<PreflightFacts> = {}) =>
    evaluatePreflight(facts({ purpose: 'backup', r2: r2Facts(), ...overrides }));
  const detail = (probes: readonly Probe[], name: string) =>
    probes.find((probe) => probe.name === name)?.detail ?? '';
  const state = (probes: readonly Probe[], name: string) =>
    probes.find((probe) => probe.name === name)?.state;

  it("does not lend other/'s 30 days to a 7-day export prefix", () => {
    // The exact reported defect: two prefixes, two durations, one wrong answer.
    const probes = backup({
      r2: r2Facts({
        expiryRules: [expiry('pilot/', 7), expiry('other/', 30)],
        lockRules: [lock('pilot/', 7), lock('other/', 30)],
      }),
    });
    expect(state(probes, 'bucket retention')).toBe('FAIL');
    expect(state(probes, 'bucket lock')).toBe('FAIL');
    expect(detail(probes, 'bucket retention')).toContain('7-day expiry applies to pilot/');
    expect(detail(probes, 'bucket lock')).toContain('7-day lock applies to pilot/');
    // And it never says the 30-day number is in force for pilot/.
    expect(detail(probes, 'bucket retention')).not.toContain('30-day expiry applies to pilot/');
    expect(detail(probes, 'bucket lock')).not.toContain('30-day lock applies to pilot/');
  });

  it('does not protect the export prefix with a rule that is only on another prefix', () => {
    const probes = backup({
      r2: r2Facts({ expiryRules: [expiry('other/', 30)], lockRules: [lock('other/', 30)] }),
    });
    expect(state(probes, 'bucket retention')).toBe('FAIL');
    expect(state(probes, 'bucket lock')).toBe('FAIL');
    expect(detail(probes, 'bucket lock')).toContain('other/');
    expect(detail(probes, 'bucket lock')).toContain('does not apply to this prefix');
  });

  it('passes a rule that has the right prefix, the right duration and is enabled', () => {
    const probes = backup({
      r2: r2Facts({ expiryRules: [expiry('pilot/', 30)], lockRules: [lock('pilot/', 30)] }),
    });
    expect(failures(probes)).toEqual([]);
    expect(state(probes, 'bucket retention')).toBe('PASS');
    expect(state(probes, 'bucket lock')).toBe('PASS');
  });

  it('refuses a rule on the right prefix that is disabled', () => {
    const probes = backup({
      r2: r2Facts({
        expiryRules: [expiry('pilot/', 30, 'expire-pilot', false), expiry('other/', 30)],
        lockRules: [lock('pilot/', 30, 'lock-pilot', false), lock('other/', 30)],
      }),
    });
    expect(state(probes, 'bucket retention')).toBe('FAIL');
    expect(state(probes, 'bucket lock')).toBe('FAIL');
    expect(detail(probes, 'bucket retention')).toContain('disabled, so it enforces nothing');
    expect(detail(probes, 'bucket lock')).toContain('disabled, so it enforces nothing');
  });

  it('refuses a rule on the right prefix whose age cannot be read', () => {
    // A rule that deletes objects at an unreadable age is not an absent rule and
    // not a passing one: the preflight says so instead of guessing either way.
    const probes = backup({
      r2: r2Facts({
        expiryRules: [unreadableExpiry('pilot/'), expiry('other/', 30)],
        lockRules: [unreadableLock('pilot/'), lock('other/', 30)],
      }),
    });
    expect(state(probes, 'bucket retention')).toBe('FAIL');
    expect(state(probes, 'bucket lock')).toBe('FAIL');
    expect(detail(probes, 'bucket retention')).toContain('could not be read');
    expect(detail(probes, 'bucket lock')).toContain('could not be read');
  });

  it('evaluates a wider rule that covers the export prefix by what really applies', () => {
    // A bucket-wide rule is in force for pilot/, so on its own it passes.
    const wide = backup({ r2: r2Facts({ expiryRules: [expiry('', 30)], lockRules: [lock('', 30)] }) });
    expect(failures(wide)).toEqual([]);

    // And with a shorter rule also in force, the two kinds answer differently:
    // expiry fires at the *earliest* matching age (7), while a lock holds while
    // *any* matching rule is still in force (the longer 30).
    const mixed = backup({
      r2: r2Facts({
        expiryRules: [expiry('', 30), expiry('pilot/', 7)],
        lockRules: [lock('', 30), lock('pilot/', 7)],
      }),
    });
    expect(state(mixed, 'bucket retention')).toBe('FAIL');
    expect(detail(mixed, 'bucket retention')).toContain('7-day expiry applies to pilot/');
    expect(state(mixed, 'bucket lock')).toBe('PASS');
    expect(detail(mixed, 'bucket lock')).toContain('30-day lock applies to pilot/');
  });

  it('takes the earliest expiry and the latest lock when several rules overlap', () => {
    // Two rules are in force for the same object, and the kinds answer differently:
    // the export prefix expires at the earliest matching age, and stays locked for
    // as long as any matching rule holds it.
    const probes = backup({
      r2: r2Facts({
        expiryRules: [expiry('pilot/', 90), expiry('', 7)],
        lockRules: [lock('pilot/', 7), lock('', 90)],
      }),
    });
    expect(state(probes, 'bucket retention')).toBe('FAIL');
    expect(detail(probes, 'bucket retention')).toContain('7-day expiry applies to pilot/');
    expect(state(probes, 'bucket lock')).toBe('PASS');
    expect(detail(probes, 'bucket lock')).toContain('90-day lock applies to pilot/');
  });

  it('does not let a rule on a deeper prefix answer for the export prefix itself', () => {
    // `pilot/sub/` protects objects under it, not `pilot/x.sql`. A rule there is
    // not retention for the exports, whatever its duration.
    const probes = backup({
      r2: r2Facts({ expiryRules: [expiry('pilot/sub/', 30)], lockRules: [lock('pilot/sub/', 30)] }),
    });
    expect(state(probes, 'bucket retention')).toBe('FAIL');
    expect(state(probes, 'bucket lock')).toBe('FAIL');
    expect(detail(probes, 'bucket retention')).toContain('pilot/sub/');
  });

  it('reads a lifecycle configuration with rules on other prefixes and other durations', () => {
    // The rules that are not about exports must not be able to carry the answer.
    const probes = backup({
      r2: r2Facts({
        expiryRules: [expiry('logs/', 365), expiry('pilot/archive/', 90), expiry('pilot/', 30)],
        lockRules: [lock('logs/', 365), lock('pilot/archive/', 90), lock('pilot/', 30)],
      }),
    });
    expect(failures(probes)).toEqual([]);
    expect(detail(probes, 'bucket retention')).toContain('30-day expiry applies to pilot/');
    expect(detail(probes, 'bucket lock')).toContain('30-day lock applies to pilot/');
  });

  it('does not accept a lookalike prefix that does not cover the export prefix', () => {
    for (const prefix of ['pilot-archive/', 'pilot_backup/', 'PILOT/']) {
      const probes = backup({
        r2: r2Facts({ expiryRules: [expiry(prefix, 30)], lockRules: [lock(prefix, 30)] }),
      });
      expect(state(probes, 'bucket retention')).toBe('FAIL');
      expect(state(probes, 'bucket lock')).toBe('FAIL');
    }
  });

  it('counts a deeper prefix as covered by the export prefix', () => {
    // `pilot/2026-10-31/…` is what a rule on `pilot/` actually protects.
    expect(prefixCovers('pilot/', 'pilot/x.sql')).toBe(true);
    expect(prefixCovers('pilot', 'pilot/x.sql')).toBe(true);
    // A prefix is a string prefix: `pilot-archive/` and `PILOT/` are other places.
    expect(prefixCovers('pilot/', 'pilot-archive/x.sql')).toBe(false);
    expect(prefixCovers('PILOT/', 'pilot/x.sql')).toBe(false);
  });

  it('never reports a PASS for a rule set it could not read', () => {
    const probes = backup({
      r2: r2Facts({
        lifecycle: { readable: false, detail: 'reading the lifecycle answered 403.', rules: [] },
        lock: { readable: false, detail: 'reading the bucket lock answered 403.', rules: [] },
      }),
    });
    expect(state(probes, 'bucket retention')).toBe('FAIL');
    expect(state(probes, 'bucket lock')).toBe('FAIL');
    expect(detail(probes, 'bucket retention')).toContain('403');
  });
});

describe('reading the API rules', () => {
  it('keeps each lifecycle rule with its own prefix and age, in the flat shape', () => {
    const rules = readExpiryRules({
      rules: [
        { id: 'a', enabled: true, prefix: 'pilot/', deleteObjectsAfterDays: 7 },
        { id: 'b', enabled: false, prefix: 'other/', deleteObjectsAfterDays: 30 },
      ],
    });
    expect(rules).toEqual([
      { id: 'a', prefix: 'pilot/', enabled: true, days: 7, unreadable: false },
      { id: 'b', prefix: 'other/', enabled: false, days: 30, unreadable: false },
    ]);
    expect(effectiveExpiry(rules, 'pilot/').days).toBe(7);
  });

  it('reads the nested shape, where the age is in seconds', () => {
    const rules = readExpiryRules({
      rules: [
        {
          id: 'nested',
          enabled: true,
          conditions: { prefix: 'pilot/' },
          deleteObjectsTransition: { condition: { type: 'Age', maxAgeSeconds: 30 * 86_400 } },
        },
      ],
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.days).toBe(30);
    expect(rules[0]?.prefix).toBe('pilot/');
    expect(effectiveExpiry(rules, 'pilot/').days).toBe(30);
  });

  it('treats a rule with no deletion transition as not an expiry rule, not as short retention', () => {
    const rules = readExpiryRules({
      rules: [
        { id: 'abort', enabled: true, prefix: 'pilot/', abortMultipartUploadsTransition: { condition: { type: 'Age', maxAgeSeconds: 86_400 } } },
        { id: 'expire', enabled: true, prefix: 'pilot/', deleteObjectsAfterDays: 30 },
      ],
    });
    expect(rules[0]).toMatchObject({ id: 'abort', days: null, unreadable: false });
    const reading = effectiveExpiry(rules, 'pilot/');
    expect(reading.covering.map((rule) => rule.id)).toEqual(['expire']);
    expect(reading.days).toBe(30);
    expect(reading.unreadable).toEqual([]);
  });

  it('marks a deletion rule whose age is unreadable, and does not treat it as absent', () => {
    const rules = readExpiryRules({
      rules: [
        { id: 'odd', enabled: true, prefix: 'pilot/', deleteObjectsTransition: { condition: { type: 'Date' } } },
        { id: 'zero', enabled: true, prefix: 'pilot/', deleteObjectsAfterDays: 0 },
      ],
    });
    expect(rules.every((rule) => rule.unreadable)).toBe(true);
    const reading = effectiveExpiry(rules, 'pilot/');
    expect(reading.days).toBeNull();
    expect(reading.unreadable).toHaveLength(2);
  });

  it('reads lock rules with their prefixes, and keeps an absent age unreadable', () => {
    const rules = readLockRules({
      rules: [
        { id: 'l1', enabled: true, prefix: 'pilot/', condition: { type: 'Age', maxAgeSeconds: 30 * 86_400 } },
        { id: 'l2', enabled: false, prefix: 'other/', condition: { type: 'Age', maxAgeSeconds: 90 * 86_400 } },
        { id: 'l3', enabled: true, prefix: 'pilot/' },
      ],
    });
    expect(rules[0]).toMatchObject({ prefix: 'pilot/', days: 30, enabled: true });
    expect(rules[1]).toMatchObject({ prefix: 'other/', days: 90, enabled: false });
    expect(rules[2]).toMatchObject({ prefix: 'pilot/', days: null, unreadable: true });

    const reading = effectiveLock(rules, 'pilot/');
    expect(reading.days).toBe(30);
    expect(reading.unreadable.map((entry) => entry.id)).toEqual(['l3']);
  });

  it('takes the latest lock and the earliest expiry from rules that both apply', () => {
    expect(effectiveLock([lock('pilot/', 30), lock('', 90)], 'pilot/').days).toBe(90);
    expect(effectiveExpiry([expiry('pilot/', 30), expiry('', 7)], 'pilot/').days).toBe(7);
  });

  it('ignores a response that is not a rule list instead of inventing rules', () => {
    expect(readExpiryRules(null)).toEqual([]);
    expect(readExpiryRules({ rules: 'nope' })).toEqual([]);
    expect(readExpiryRules({ rules: [null, 7, 'x'] })).toEqual([]);
    expect(readLockRules(undefined)).toEqual([]);
    // A prefix that is not a string is an unknown scope, and an unknown scope may
    // cover the target: it is reported as unreadable rather than skipped.
    const rules = readExpiryRules({ rules: [{ id: 'weird', enabled: true, prefix: 42, deleteObjectsAfterDays: 30 }] });
    expect(rules[0]?.prefix).toBeNull();
    expect(effectiveExpiry(rules, 'pilot/').unreadable).toHaveLength(1);
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
