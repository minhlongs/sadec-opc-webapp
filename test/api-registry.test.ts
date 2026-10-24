import { describe, expect, it } from 'vitest';
import {
  assertRegistryIsSound,
  contextFromRequest,
} from '../src/worker/api.ts';
import type { Route, RouteRegistry } from '../src/worker/api.ts';

function registryOf(routes: Route[]): RouteRegistry {
  return { routes };
}

describe('the route registry', () => {
  it('accepts a registry whose every route is declared', () => {
    expect(() =>
      assertRegistryIsSound(
        registryOf([
          { kind: 'public', path: '/api/health' },
          { kind: 'guarded', path: '/api/orders', action: 'order.read' },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects a guarded route that names no action', () => {
    // A guarded route with no action is a route nobody checked, which is the
    // failure this registry exists to catch.
    expect(() =>
      assertRegistryIsSound(
        registryOf([{ kind: 'guarded', path: '/api/orders', action: '  ' }]),
      ),
    ).toThrow(/names no action/i);
  });

  it('rejects the same path registered twice', () => {
    expect(() =>
      assertRegistryIsSound(
        registryOf([
          { kind: 'public', path: '/api/health' },
          { kind: 'public', path: '/api/health' },
        ]),
      ),
    ).toThrow(/registered twice/i);
  });

  it('accepts an empty registry, since an app with no routes yet has none', () => {
    // An empty registry is not an error: the shell phase starts with only a
    // health route. What matters is that adding a route requires declaring it.
    expect(() => assertRegistryIsSound(registryOf([]))).not.toThrow();
  });

  it('refuses a registry whose only route is guarded without permission data', () => {
    expect(() =>
      assertRegistryIsSound(
        registryOf([
          { kind: 'public', path: '/api/health' },
          { kind: 'guarded', path: '/api/orders', action: '' },
        ]),
      ),
    ).toThrow(/names no action/i);
  });
});

describe('context never trusts the request for identity', () => {
  it('reads a workspace from the query without treating it as identity', () => {
    const context = contextFromRequest(
      { accessSubject: 'sub-1', email: 'a@example.test' },
      new URLSearchParams('workspace_id=ws-a'),
    );
    expect(context.identity?.accessSubject).toBe('sub-1');
    expect(context.workspaceId).toBe('ws-a');
  });

  it('carries no identity when none was verified', () => {
    const context = contextFromRequest(null, new URLSearchParams('workspace_id=ws-a'));
    expect(context.identity).toBeNull();
    // The workspace name still travels, so authorize can deny on membership
    // rather than on a missing field.
    expect(context.workspaceId).toBe('ws-a');
  });

  it('leaves the workspace unset when the request names none', () => {
    const context = contextFromRequest(
      { accessSubject: 'sub-1', email: null },
      new URLSearchParams(),
    );
    expect(context.workspaceId).toBeNull();
  });
});
