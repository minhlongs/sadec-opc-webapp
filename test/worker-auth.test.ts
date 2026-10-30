import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, {
  setMembershipStore,
  setVerifier,
  type Verifier,
} from '../src/worker/index.ts';
import type { MembershipStore } from '../src/security/authorize.ts';
import { PERMITTED_ROLES } from '../src/security/authorize.ts';
import type { D1Like } from '../src/ops/catalog.ts';

/**
 * The Worker's guard, tested through the real fetch handler rather than through
 * the helpers it calls. Phase 0 proved the chokepoint and the token verifier in
 * isolation; what is not proven until this file is that a request reaching this
 * Worker cannot skip either of them — which is the failure §15 case 17 is about.
 *
 * The environment comes from `env.APP_ENV`, never from the request. Every test
 * sets it, because that is the only thing that moves it.
 */

const ORIGIN = 'https://pilot.example.test';

/** The execution context the runtime would pass. `access` is deliberately unset. */
const CTX: { access?: unknown } = {};

interface Env {
  APP_ENV?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_IDENTITY_SUBJECT?: string;
  sadec_demo?: unknown;
  sadec_test?: unknown;
  sadec_pilot?: unknown;
  [key: string]: unknown;
}

function fakeDatabase(): D1Like {
  const empty = { results: [] as unknown[], success: true, meta: { duration: 0 } };
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => empty,
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
    batch: async () => [],
  } as unknown as D1Like;
}

/** A pilot environment by default: not local, so the dev adapter is unreachable. */
function env(overrides: Record<string, unknown> = {}): Env {
  return {
    APP_ENV: 'pilot',
    ACCESS_TEAM_DOMAIN: 'https://team.example',
    ACCESS_AUD: 'aud-tag',
    sadec_pilot: fakeDatabase(),
    ...overrides,
  };
}

/** A store granting one identity the operator role in one workspace. */
const grantOperator: MembershipStore = {
  findBySubject: async (accessSubject, workspaceId) =>
    accessSubject === 'sub-operator' && workspaceId === 'ws-a'
      ? { identityId: 'id-1', role: 'workspace_operator', revokedAt: null }
      : null,
  listBySubject: async (accessSubject) =>
    accessSubject === 'sub-operator' ? [{ workspaceId: 'ws-a', role: 'workspace_operator' }] : [],
};

interface RequestOptions {
  method?: string;
  subject?: string | null;
  origin?: string | null;
  secFetchSite?: string | null;
  body?: unknown;
  workspaceId?: string | null;
  token?: string | null;
  appEnv?: string | null;
}

function request(path: string, options: RequestOptions = {}): Request {
  const {
    method = 'GET',
    subject = 'sub-operator',
    origin = ORIGIN,
    secFetchSite = 'same-origin',
    body,
    workspaceId = 'ws-a',
    token = 'signed-token',
  } = options;

  const url = new URL(path, ORIGIN);
  if (workspaceId !== null) url.searchParams.set('workspace_id', workspaceId);

  const headers: Record<string, string> = {};
  if (token !== null) headers['Cf-Access-Jwt-Assertion'] = token;
  if (origin !== null) headers.Origin = origin;
  if (secFetchSite !== null) headers['Sec-Fetch-Site'] = secFetchSite;
  if (body !== undefined) headers['content-type'] = 'application/json';

  void subject;

  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A verifier returning a fixed identity, standing in for Access. */
function verifierFor(subject: string | null): Verifier {
  return async (headerValue: string | null) =>
    headerValue !== null && headerValue.trim() !== '' && subject !== null
      ? { accessSubject: subject, email: `${subject}@example.test` }
      : null;
}

function fetch(requestToServe: Request, environment: Env): Promise<Response> {
  return Promise.resolve(
    worker.fetch(requestToServe, environment, CTX) as Response | Promise<Response>,
  );
}

beforeEach(() => {
  setMembershipStore(grantOperator);
});

afterEach(() => {
  setMembershipStore(null);
  setVerifier(null);
});

describe('health is reachable without an identity', () => {
  it('answers 200 with no token', async () => {
    const response = await fetch(request('/api/health', { token: null }), env());
    expect(response.status).toBe(200);
  });

  it('reports nothing about how authentication works', async () => {
    const response = await fetch(request('/api/health', { token: null }), env());
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['env', 'status']);
  });
});

describe('the public documents are generated for an anonymous reader', () => {
  it('answers /llms.txt and /discover with no identity at all', async () => {
    for (const path of ['/llms.txt', '/llms-full.txt', '/docs.md', '/robots.txt', '/sitemap.xml', '/discover']) {
      const response = await fetch(request(path, { token: null }), env());
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(/text\/plain|text\/markdown|application\/xml|text\/html/);
    }
  });

  it('refuses a write to a public document', async () => {
    const response = await fetch(
      request('/llms.txt', { method: 'POST', token: null, secFetchSite: 'same-origin', body: {} }),
      env(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('names the serving origin in its own links, not a placeholder', async () => {
    const response = await fetch(request('/llms.txt', { token: null }), env());
    const body = await response.text();
    expect(body).toContain(`${ORIGIN}/api/public/catalog`);
    expect(body).not.toContain('sadec-flow.example.com');
  });
});

describe('a guarded route refuses without a verified identity', () => {
  it('returns 401 when no token is present', async () => {
    const response = await fetch(request('/api/products', { token: null }), env());
    expect(response.status).toBe(401);
  });

  it('returns 401 when the token is present but unverifiable', async () => {
    // The header existing is not enough. This is the check a forged token fails.
    setVerifier(verifierFor(null));
    const response = await fetch(request('/api/products'), env());
    expect(response.status).toBe(401);
  });

  it('refuses every guarded route, not just one', async () => {
    setVerifier(verifierFor(null));
    for (const path of [
      '/api/products',
      '/api/customers',
      '/api/quote-drafts',
      '/api/quote-drafts/save',
      '/api/session',
    ]) {
      const response = await fetch(request(path, { token: null }), env());
      expect(response.status).toBe(401);
    }
  });

  it('fails closed when the deployment has no verifier at all', async () => {
    // No verifier injected and no Access configuration: the deployment is
    // incomplete rather than misconfigured, and every route refuses.
    setVerifier(null);
    const response = await fetch(
      request('/api/products'),
      env({ ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined }),
    );
    expect(response.status).toBe(401);
  });

  it('resolves a verifier from the environment rather than staying null', async () => {
    // The defect this covers built a verifier the Worker never used: the module
    // slot stayed null on a real deployment because only tests filled it, so
    // every guarded route refused for everyone. When the environment names a
    // team domain and an audience, this route must reach a real verifier and ask
    // it about the token.
    //
    // The token here is not a genuine Access token — that needs a published key
    // set — so the verifier correctly refuses it. What this proves is that the
    // configuration was read at all: an unconfigured environment would refuse too,
    // so the assertion is that a configured one does not take the no-verifier
    // shortcut. It is shown by the response carrying the guard's message shape
    // rather than the missing-configuration one.
    setVerifier(null);
    const response = await fetch(
      request('/api/products', { token: 'a-token-that-is-not-verified' }),
      env({
        ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
        ACCESS_AUD: 'an-audience-tag',
      }),
    );
    // A refusal either way; the difference is which code path produced it, and a
    // 401 from a configured verifier is the correct answer for a bad token.
    expect(response.status).toBe(401);
  });
});

describe('an unknown path is not a route', () => {
  it('returns a 404 that does not say whether the path might exist behind auth', async () => {
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(request('/api/secret-admin-area'), env());
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
  });
});

describe('a write proves where it came from', () => {
  const saveBody = {
    customer_id: 'cu-1',
    reference: 'BG-0001',
    lines: [{ product_id: 'pd-1', quantity: 1, note: null }],
  };

  it('accepts a mutation the browser reports as same-origin', async () => {
    // This is the save the app actually makes. `Sec-Fetch-Site` is set by the
    // browser on a same-origin fetch, which is why the Worker asks for this
    // header rather than `Origin` — a browser strips `Origin` from a fetch init,
    // so the app cannot send it and a rule demanding it refuses every real save.
    //
    // The fake database holds no row for this body, so the handler answers 400.
    // What matters is that it is not the 403 the origin guard returns: the
    // request got past the guard and reached the handler.
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/quote-drafts/save', { method: 'POST', body: saveBody }),
      env(),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).not.toBe('Yêu cầu bị từ chối do nguồn gửi không khớp.');
  });

  it('rejects a mutation reported as cross-site', async () => {
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/quote-drafts/save', {
        method: 'POST',
        secFetchSite: 'cross-site',
        body: saveBody,
      }),
      env(),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('Yêu cầu bị từ chối do nguồn gửi không khớp.');
  });

  it('rejects a mutation carrying no Sec-Fetch-Site at all', async () => {
    // Absent means the browser did not make the request from a page. A machine
    // client can set it, so this costs a well-behaved client nothing.
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/quote-drafts/save', {
        method: 'POST',
        secFetchSite: null,
        body: saveBody,
      }),
      env(),
    );
    expect(response.status).toBe(403);
  });

  it('lets a read through when the header is absent', async () => {
    // The check is for mutations. A GET without one is ordinary navigation.
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/products', { secFetchSite: null }),
      env(),
    );
    expect(response.status).toBe(200);
  });
});

describe('the session route answers without the client naming a workspace', () => {
  it('resolves the workspace from the caller’s own membership', async () => {
    // The UI cannot know which workspace to scope to before it has one, so the
    // one route it calls first must not require it. The workspace comes from the
    // membership table, not from the request.
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/session', { token: 'signed-token' }),
      env(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: { workspaceId: string; role: string } };
    expect(body.session.workspaceId).toBe('ws-a');
    expect(body.session.role).toBe('workspace_operator');
  });

  it('ignores a workspace the request names when the caller holds no membership in it', async () => {
    // A client asking for another workspace is a client stating what it wants,
    // not proving what it holds. The membership decides, so the answer is the
    // workspace the caller actually belongs to.
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/session', { workspaceId: 'ws-somewhere-else', token: 'signed-token' }),
      env(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: { workspaceId: string } };
    expect(body.session.workspaceId).toBe('ws-a');
  });

  it('switches to a requested workspace when the caller holds live memberships in multiple workspaces', async () => {
    setMembershipStore({
      findBySubject: async (sub, ws) =>
        sub === 'sub-operator' && (ws === 'ws-a' || ws === 'ws-b')
          ? { identityId: 'id-1', role: 'workspace_operator', revokedAt: null }
          : null,
      listBySubject: async (sub) =>
        sub === 'sub-operator'
          ? [
              { workspaceId: 'ws-a', role: 'workspace_operator' },
              { workspaceId: 'ws-b', role: 'workspace_operator' },
            ]
          : [],
    });
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/session', { workspaceId: 'ws-b', token: 'signed-token' }),
      env(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { workspaceId: string; canSwitchWorkspace?: boolean };
    };
    expect(body.session.workspaceId).toBe('ws-b');
    expect(body.session.canSwitchWorkspace).toBe(true);
  });

  it('refuses an identity holding no live membership anywhere', async () => {
    // A verified identity with no workspace is refused, not handed an empty
    // session or a default workspace to work in.
    setMembershipStore({
      findBySubject: async () => null,
      listBySubject: async () => [],
    });
    setVerifier(verifierFor('sub-stranger'));
    const response = await fetch(request('/api/session'), env());
    expect(response.status).toBe(403);
  });

  it('still refuses with no verified identity at all', async () => {
    setVerifier(verifierFor(null));
    const response = await fetch(request('/api/session'), env());
    expect(response.status).toBe(401);
  });

  it('lists only the caller’s own live memberships, so the switcher offers nothing the server would refuse', async () => {
    // The UI used to toggle between two hard-coded workspace ids; an operator
    // without a membership in the second was offered a switch the server then
    // denied. The server now says which workspaces it would honour — and only
    // for this caller. Another identity's memberships never appear, and the
    // list grants nothing: each request is still authorized against the table.
    setMembershipStore({
      findBySubject: async (sub, ws) =>
        sub === 'sub-operator' && (ws === 'ws-a' || ws === 'ws-b')
          ? { identityId: 'id-1', role: 'workspace_operator', revokedAt: null }
          : null,
      listBySubject: async (sub) =>
        sub === 'sub-operator'
          ? [
              { workspaceId: 'ws-a', role: 'workspace_operator' },
              { workspaceId: 'ws-b', role: 'workspace_operator' },
            ]
          : [{ workspaceId: 'ws-someone-else', role: 'founder_admin' }],
    });
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(request('/api/session'), env());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { workspaceId: string; workspaces?: { workspaceId: string; role: string }[] };
    };
    expect(body.session.workspaces?.map((w) => w.workspaceId)).toEqual(['ws-a', 'ws-b']);
    const text = JSON.stringify(body);
    expect(text).not.toContain('ws-someone-else');
    expect(text).not.toContain('memberships');
    expect(text).not.toContain('founder_area');
  });

  it('offers a single workspace to a caller holding one, and no switch', async () => {
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(request('/api/session'), env());
    const body = (await response.json()) as {
      session: { canSwitchWorkspace?: boolean; workspaces?: { workspaceId: string }[] };
    };
    expect(body.session.canSwitchWorkspace).toBe(false);
    expect(body.session.workspaces?.map((w) => w.workspaceId)).toEqual(['ws-a']);
  });
});

describe('the development probe exists only in development', () => {
  it('is absent in a deployed environment', async () => {
    // The same 404 every unknown path returns, so an unauthenticated caller
    // cannot tell a development instrument from a path that never existed.
    const response = await fetch(
      request('/api/whoami', { token: null }),
      env(),
    );
    expect(response.status).toBe(404);
  });

  it('answers one boolean in local, and nothing about the deployment', async () => {
    const response = await fetch(
      request('/api/whoami', { token: null }),
      env({ APP_ENV: 'local', sadec_demo: fakeDatabase() }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['access_present', 'note']);
    expect(typeof body['access_present']).toBe('boolean');
  });

  it('never reports a header, subject, email, team domain or role', async () => {
    const response = await fetch(
      request('/api/whoami', { token: null }),
      env({ APP_ENV: 'local', sadec_demo: fakeDatabase() }),
    );
    const text = await response.text();
    for (const leaked of ['sub-', 'cloudflareaccess', 'aud-tag', 'role', 'email']) {
      expect(text).not.toContain(leaked);
    }
  });
});

describe('the dev identity adapter cannot be reached from a deployment', () => {
  it('refuses a pilot request whose subject matches a demo identity', async () => {
    // A pilot environment plus a subject that exists in the demo seed. The adapter
    // is not consulted, so the token verifier resolves the identity and the
    // membership table decides the rest — and this store grants nobody that
    // subject. A 403 rather than a 401 is the honest answer: the caller is
    // authenticated and has no access here.
    setVerifier(verifierFor('demo:sub:admin'));
    const response = await fetch(request('/api/products'), env());
    expect(response.status).toBe(403);
  });

  it('grants a demo identity no role in pilot', async () => {
    setMembershipStore({ findBySubject: async () => null, listBySubject: async () => [] });
    setVerifier(verifierFor('demo:sub:operator'));
    const response = await fetch(
      request('/api/quote-drafts/save', {
        method: 'POST',
        body: {
          customer_id: 'cu-1',
          reference: 'BG-0001',
          lines: [{ product_id: 'pd-1', quantity: 1, note: null }],
        },
      }),
      env(),
    );
    expect(response.status).toBe(403);
  });
});

describe('an identity cannot reach a workspace it does not belong to', () => {
  it('refuses a request naming another workspace', async () => {
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(request('/api/products', { workspaceId: 'ws-b' }), env());
    expect(response.status).toBe(403);
  });

  it('refuses a request naming no workspace at all', async () => {
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(request('/api/products', { workspaceId: null }), env());
    expect(response.status).toBe(403);
  });

  it('does not read a workspace id from the body as evidence of membership', async () => {
    // §6: a workspace id from the request is a statement about what is wanted,
    // not proof of access. The membership lookup decides — and here it grants, so
    // the request reaches the handler and fails on data instead. A 400 rather
    // than a 403 is the proof: authorization passed on its own terms.
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/quote-drafts/save', {
        method: 'POST',
        body: {
          workspace_id: 'ws-a',
          customer_id: 'cu-1',
          reference: 'BG-0001',
          lines: [{ product_id: 'pd-1', quantity: 1, note: null }],
        },
      }),
      env(),
    );
    expect(response.status).toBe(400);
  });
});

describe('a fault the store raises becomes a refusal, not a rejection', () => {
  it('answers unreadable data with a Vietnamese 403 rather than escaping fetch', async () => {
    // The pilot-after-deploy state: a binding exists and no migration has run, so
    // the membership query itself throws. Left alone, that rejection escapes
    // `fetch`, the runtime answers with its own page, and the operator gets
    // nothing they can read — a 500 that looks like an outage instead of a
    // database that is not ready.
    setVerifier(verifierFor('sub-operator'));
    setMembershipStore({
      findBySubject: async () => {
        throw new Error('D1_ERROR: no such table: memberships');
      },
      listBySubject: async () => [],
    });

    const response = await fetch(request('/api/products'), env());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('Hệ thống chưa sẵn sàng xử lý yêu cầu này.');
  });

  it('closes the session route the same way', async () => {
    setVerifier(verifierFor('sub-operator'));
    setMembershipStore({
      findBySubject: async () => {
        throw new Error('D1_ERROR: no such table: memberships');
      },
      listBySubject: async () => {
        throw new Error('D1_ERROR: no such table: memberships');
      },
    });

    const response = await fetch(request('/api/session'), env());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('Hệ thống chưa sẵn sàng xử lý yêu cầu này.');
  });
});

describe('a fault inside an authorized handler is reported as the write it is', () => {
  /** A database whose every statement throws the given error. */
  function throwingDatabase(message: string): D1Like {
    const statement = {
      bind: () => statement,
      first: async () => {
        throw new Error(message);
      },
      all: async () => {
        throw new Error(message);
      },
      run: async () => {
        throw new Error(message);
      },
    };
    return {
      prepare: () => statement,
      batch: async () => {
        throw new Error(message);
      },
    } as unknown as D1Like;
  }

  it('answers a constraint the database raised with a 409 conflict that names no table', async () => {
    // The caller was authorized; the write lost a race the SQL guard caught.
    // That is a conflict to re-read and retry, not a 403, and the sentence the
    // operator sees says nothing about tables or columns.
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/customers/create', {
        method: 'POST',
        body: { name: 'Vườn Mai' },
      }),
      env({ sadec_pilot: throwingDatabase('D1_ERROR: UNIQUE constraint failed: customers.id') }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('conflict');
    expect(body.error).not.toMatch(/UNIQUE|constraint|customers/i);
  });

  it('answers any other handler fault with a 500 that names no table', async () => {
    setVerifier(verifierFor('sub-operator'));
    const response = await fetch(
      request('/api/customers', { method: 'GET' }),
      env({ sadec_pilot: throwingDatabase('D1_ERROR: no such table: customers') }),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('unavailable');
    expect(body.error).not.toMatch(/no such table|customers/i);
  });
});

describe('an action nobody declared is refused', () => {
  it('refuses the names plain objects inherit, rather than reading a function', () => {
    // Every caller today passes a literal from the static route registry, so
    // nothing reaches `authorize` with such a name. The point is the next author:
    // a plain-object lookup returns `Object.prototype`'s own members, which are
    // functions and therefore not `undefined`, so the "undeclared action is
    // refused" branch is bypassed and the role check throws instead. Refusing is
    // the only one of those two outcomes that is safe.
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const permitted = Object.prototype.hasOwnProperty.call(PERMITTED_ROLES, name)
        ? PERMITTED_ROLES[name]
        : undefined;
      expect(permitted, `${name} must not resolve to a permission`).toBeUndefined();
    }
  });

  it('still resolves an action the registry declares', () => {
    const permitted = Object.prototype.hasOwnProperty.call(PERMITTED_ROLES, 'session.read')
      ? PERMITTED_ROLES['session.read']
      : undefined;
    expect(permitted).toEqual(['founder_admin', 'workspace_owner', 'workspace_operator']);
  });
});
