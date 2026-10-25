import { describe, expect, it } from 'vitest';
import {
  DEMO_IDENTITIES,
  DEMO_IDENTITY_LABEL,
  devIdentityIsAvailable,
  resolveDevIdentity,
} from '../src/security/dev-identity.ts';

/**
 * §6 constrains the dev identity adapter in four ways, and three of them are
 * things a later edit could break by accident: it exists only in local and test,
 * it cannot be activated by anything the client sends, and it does not hand
 * founder_admin to whoever asks first. These tests are the record that the
 * constraints held, checked against the module rather than against a demo.
 */

describe('the adapter exists only where it is permitted', () => {
  it('is available in local and test', () => {
    expect(devIdentityIsAvailable('local')).toBe(true);
    expect(devIdentityIsAvailable('test')).toBe(true);
  });

  it('is unavailable in every other environment, however the value is written', () => {
    expect(devIdentityIsAvailable('pilot')).toBe(false);
    expect(devIdentityIsAvailable('demo')).toBe(false);
    expect(devIdentityIsAvailable('production')).toBe(false);
    // An unset or differently-cased environment is not a local one. Closing on a
    // typo is the point: an unconfigured deployment is refused, not made
    // convenient.
    expect(devIdentityIsAvailable(undefined)).toBe(false);
    expect(devIdentityIsAvailable('')).toBe(false);
    expect(devIdentityIsAvailable('   ')).toBe(false);
  });

  it('resolves nothing at all outside local and test', () => {
    // This is the guard the deployment depends on: no code path produces a demo
    // identity outside development, so a production request always falls through
    // to the Access token and is refused without one.
    expect(resolveDevIdentity('pilot', 'demo:sub:admin')).toBeNull();
    expect(resolveDevIdentity(undefined, 'demo:sub:admin')).toBeNull();
  });
});

describe('the subject comes from configuration, never from the request', () => {
  it('defaults to the operator, not the founder', () => {
    const identity = resolveDevIdentity('local', undefined);
    expect(identity?.role).toBe('workspace_operator');
    // §6's rule in one line: the default is the least-privileged role, so a
    // developer who names nobody gets an operator rather than an admin.
  });

  it('resolves the founder only when the configuration names the demo admin', () => {
    const identity = resolveDevIdentity('local', 'demo:sub:admin');
    expect(identity?.role).toBe('founder_admin');
  });

  it('refuses the session when the configured subject names no demo identity', () => {
    // Fail-closed on a typo. Silently degrading to a lower role would let a
    // developer believe they were testing as the identity they named, which is
    // how a permission test passes against the wrong role.
    expect(resolveDevIdentity('local', 'demo:sub:someone-else')).toBeNull();
  });

  it('treats a whitespace-only configuration as unset', () => {
    const identity = resolveDevIdentity('local', '   ');
    expect(identity?.role).toBe('workspace_operator');
  });
});

describe('the identity is labelled as a demo identity', () => {
  it('carries a display name that says DEMO', () => {
    for (const entry of DEMO_IDENTITIES) {
      expect(entry.displayName).toContain('DEMO');
      // §5: a demo session shows it is using demo data. The name is the label,
      // so a UI reads it rather than remembering to add a banner per page.
    }
  });

  it('uses contact details on the reserved example.test domain', () => {
    for (const entry of DEMO_IDENTITIES) {
      expect(entry.email).toMatch(/@example\.test$/);
      // A real address in a demo seed is how real contact data reaches a repo.
    }
  });

  it('exposes one module-level label a UI can render', () => {
    expect(DEMO_IDENTITY_LABEL).toContain('DEMO');
  });

  it('covers exactly the three roles the schema allows', () => {
    expect([...DEMO_IDENTITIES].map((entry) => entry.role).sort()).toEqual([
      'founder_admin',
      'workspace_operator',
      'workspace_owner',
    ]);
  });

  it('grants no identity a role it does not list', () => {
    // A fourth role in the seed would be a row the roles table's CHECK rejects,
    // so this guards the seed rather than the database.
    const permitted = new Set([
      'founder_admin',
      'workspace_owner',
      'workspace_operator',
    ]);
    for (const entry of DEMO_IDENTITIES) {
      expect(permitted.has(entry.role)).toBe(true);
    }
  });
});
