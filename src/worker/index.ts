/**
 * The Worker entry.
 *
 * Routes are closed until declared open. Every `/api/*` request must resolve an
 * identity and pass `authorize`; a route is reachable only by being listed as
 * public, so a route added later cannot be left unguarded by omission.
 *
 * Identity comes from the `Cf-Access-Jwt-Assertion` header, verified here rather
 * than read from `ctx.access`. Workers with Static Assets run behind an internal
 * router Worker, and that router does not pass `ctx.access` to this Worker, so
 * waiting on it would refuse the founder on a deployment while passing locally.
 *
 * In local and test, the dev identity adapter from `src/security/` supplies a
 * labelled demo identity instead. It is selected by the environment, never by
 * anything the request carries.
 */

import { authorize, authorizedWorkspaces, denialMessage, type MembershipStore, type Role } from '../security/authorize.ts';
import {
  handleAcceptRevision,
  handleCancelOrder,
  handleConfirmReceipt,
  handleCreateCustomer,
  handleCreateDelivery,
  handleCreateFollowUpTask,
  handleCreateProduct,
  handleCreateQuoteChain,
  handleCreateReceipt,
  handleIssueRevision,
  handleListCustomers,
  handleListDeliveries,
  handleListFollowUpTasks,
  handleListOrders,
  handleListProducts,
  handleListQuoteChains,
  handleListQuoteDrafts,
  handleListReceipts,
  handleOverrideDelivery,
  handlePrintableQuote,
  handleReverseReceipt,
  handleReviseQuote,
  handleSaveDraftRevision,
  handleSaveQuoteDraft,
  handleSession,
  handleTodaySummary,
  handleTransitionOrder,
  handleUpdateDeliveryStatus,
  handleUpdateFollowUpTask,
} from '../ops/routes.ts';
import {
  handleApplyImportInterviews,
  handleApplyPilotCredit,
  handleApplyProposal,
  handleConfirmOpcReceipt,
  handleCreateOpcAgreement,
  handleCreateOrUpdateInterview,
  handleCreateProposal,
  handleExportInterviews,
  handleGetConfigAndProposals,
  handleListInterviews,
  handleListOpcLedger,
  handlePreviewImportInterviews,
  handleRecordOpcObligation,
  handleRollbackConfig,
  handleRunEconomics,
} from '../founder/routes.ts';
import {
  handleListLots,
  handleCreateLot,
  handleListBookings,
  handleCreateBooking,
  handleConfirmDeposit,
  handleListHubTrips,
  handleVerifyHubPackage,
  handleInspectAndSettle,
  handlePilotDashboard,
  handleCreateHubTrip,
  handleConfirmSettlement,
} from '../ops/b2b-routes.ts';
import { IDEMPOTENCY_HEADER, withIdempotency } from '../ops/idempotency.ts';
import { handlePublicDocument, isPublicDocumentPath } from '../ops/public-documents.ts';
import { CATALOG_UNAVAILABLE_MESSAGE } from '../domain/aeo-projection.ts';
import { escrowAccountFrom } from '../domain/vietqr.ts';
import { responseForThrown } from '../ops/api-error.ts';
import {
  handlePublicCatalog,
  handlePublicDiscover,
  handlePublicSchema,
} from '../ops/public-discovery-routes.ts';
import type { D1Like } from '../ops/catalog.ts';
import { resolveDevIdentity } from '../security/dev-identity.ts';
import { accessTokenVerifier } from '../security/verify-access-token.ts';
import {
  assertRegistryIsSound,
  contextFromRequest,
  forbidden,
  unauthorized,
} from './api.ts';
import type { Route } from './api.ts';

/**
 * The verifier this deployment uses.
 *
 * Async because an Access token is verified against the team domain's published
 * key set, and fetching that set is I/O. A synchronous type here would compile a
 * Promise where a result is expected: every truthiness check on it would pass, so
 * a refusal would look like a success.
 *
 * Exported so a test can substitute its own against the same shape.
 */
export type Verifier = (
  headerValue: string | null,
) => Promise<{ accessSubject: string; email: string | null } | null>;

/**
 * The registry. A new route is added here with its action, and the registry test
 * refuses a guarded entry that names no action, so an unguarded route fails a
 * test rather than reaching a deployment.
 */
const ROUTES: Route[] = [
  // Health is public so an operator can confirm the Worker is alive. It reports
  // nothing about how authentication works.
  { kind: 'public', path: '/api/health' },

  // Bề mặt công khai cho LLM/AEO và WebMCP agent: chỉ đọc, đã lọc sạch 100% PII
  // (tên chủ vườn, số điện thoại, mã số thuế), bảo toàn bất biến ứng vốn 0đ.
  { kind: 'public', path: '/api/public/catalog' },
  { kind: 'public', path: '/api/schema' },
  { kind: 'public', path: '/api/discover' },

  // The signed-in session. Guarded rather than public because it names a role
  // and a workspace, and §6 forbids reading either from a request. It returns
  // only what the chokepoint already resolved for this caller.
  { kind: 'guarded', path: '/api/session', action: 'session.read' },

  // Reads. An operator may read the catalog and its customers; that is the job.
  { kind: 'guarded', path: '/api/products', action: 'product.read' },
  { kind: 'guarded', path: '/api/products/create', action: 'product.write' },
  { kind: 'guarded', path: '/api/customers', action: 'customer.read' },
  { kind: 'guarded', path: '/api/customers/create', action: 'customer.write' },
  { kind: 'guarded', path: '/api/quote-drafts', action: 'quote.read' },

  // Writes. Saving a quote draft is operator work, so it permits both an operator
  // and an owner. The permission table decides which, not this list.
  { kind: 'guarded', path: '/api/quote-drafts/save', action: 'quote.write' },

  // Phase 2: Operations Transactions — Quotes, Orders, Receipts, Deliveries, Tasks
  { kind: 'guarded', path: '/api/today', action: 'order.read' },
  { kind: 'guarded', path: '/api/ops/today', action: 'order.read' },
  { kind: 'guarded', path: '/api/quotes/chains', action: 'quote.read' },
  { kind: 'guarded', path: '/api/quote-chains', action: 'quote.read' },
  { kind: 'guarded', path: '/api/quotes/create', action: 'quote.write' },
  { kind: 'guarded', path: '/api/quote-chains/create', action: 'quote.write' },
  { kind: 'guarded', path: '/api/quotes/save-draft', action: 'quote.write' },
  { kind: 'guarded', path: '/api/quote-revisions/save-draft', action: 'quote.write' },
  { kind: 'guarded', path: '/api/quotes/issue', action: 'quote.write' },
  { kind: 'guarded', path: '/api/quote-revisions/issue', action: 'quote.write' },
  { kind: 'guarded', path: '/api/quotes/revise', action: 'quote.write' },
  { kind: 'guarded', path: '/api/quote-revisions/revise', action: 'quote.write' },
  { kind: 'guarded', path: '/api/quotes/accept', action: 'order.write' },
  { kind: 'guarded', path: '/api/quote-revisions/accept', action: 'order.write' },
  { kind: 'guarded', path: '/api/quotes/printable', action: 'quote.read' },
  { kind: 'guarded', path: '/api/quote-revisions/print', action: 'quote.read' },
  { kind: 'guarded', path: '/api/orders', action: 'order.read' },
  { kind: 'guarded', path: '/api/orders/transition', action: 'order.write' },
  { kind: 'guarded', path: '/api/orders/cancel', action: 'order.write' },
  { kind: 'guarded', path: '/api/receipts', action: 'order.read' },
  { kind: 'guarded', path: '/api/receipts/create', action: 'order.write' },
  { kind: 'guarded', path: '/api/receipts/confirm', action: 'receipt.confirm' },
  { kind: 'guarded', path: '/api/receipts/reverse', action: 'receipt.reverse' },
  { kind: 'guarded', path: '/api/deliveries', action: 'order.read' },
  { kind: 'guarded', path: '/api/deliveries/create', action: 'order.write' },
  { kind: 'guarded', path: '/api/deliveries/override', action: 'delivery.override_under_deposit' },
  { kind: 'guarded', path: '/api/deliveries/update-status', action: 'order.write' },
  { kind: 'guarded', path: '/api/deliveries/status', action: 'order.write' },
  { kind: 'guarded', path: '/api/tasks', action: 'order.read' },
  { kind: 'guarded', path: '/api/follow-up-tasks', action: 'order.read' },
  { kind: 'guarded', path: '/api/tasks/create', action: 'order.write' },
  { kind: 'guarded', path: '/api/follow-up-tasks/create', action: 'order.write' },
  { kind: 'guarded', path: '/api/tasks/update', action: 'order.write' },
  { kind: 'guarded', path: '/api/follow-up-tasks/update', action: 'order.write' },
  { kind: 'guarded', path: '/api/follow-up-tasks/status', action: 'order.write' },

  // Phase 3: Founder Discovery, Config Versions, Economics & OPC Commercial Ledger
  { kind: 'guarded', path: '/api/founder/interviews', action: 'founder.parameter.read' },
  { kind: 'guarded', path: '/api/founder/interviews/create', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/interviews/import-preview', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/interviews/import-apply', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/interviews/export', action: 'founder.parameter.read' },
  { kind: 'guarded', path: '/api/founder/config', action: 'founder.parameter.read' },
  { kind: 'guarded', path: '/api/founder/config/propose', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/proposals/create', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/config/apply', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/proposals/apply', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/config/rollback', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/economics', action: 'founder.parameter.read' },
  { kind: 'guarded', path: '/api/founder/opc/ledger', action: 'founder.parameter.read' },
  { kind: 'guarded', path: '/api/founder/opc/agreements/create', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/opc/obligations/record', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/opc/receipts/confirm', action: 'founder.parameter.publish' },
  { kind: 'guarded', path: '/api/founder/opc/credits/apply', action: 'founder.parameter.publish' },

  // B2B Floriculture Marketplace, Hub Consolidation & Escrow Ledger.
  { kind: 'guarded', path: '/api/b2b/lots', action: 'marketplace.lot.read' },
  { kind: 'guarded', path: '/api/b2b/lots/create', action: 'marketplace.lot.write' },
  { kind: 'guarded', path: '/api/b2b/bookings', action: 'marketplace.booking.read' },
  { kind: 'guarded', path: '/api/b2b/bookings/create', action: 'marketplace.booking.write' },
  { kind: 'guarded', path: '/api/b2b/bookings/confirm-deposit', action: 'marketplace.escrow.confirm' },
  { kind: 'guarded', path: '/api/b2b/hub-trips', action: 'hub.dispatch.read' },
  { kind: 'guarded', path: '/api/b2b/hub-trips/create', action: 'hub.dispatch.write' },
  { kind: 'guarded', path: '/api/b2b/hub-packages/verify', action: 'hub.dispatch.write' },
  { kind: 'guarded', path: '/api/b2b/bookings/inspect-and-settle', action: 'marketplace.inspect.settle' },
  // The founder confirms a settlement's cash movements the way a deposit is
  // confirmed: same action, same role boundary.
  { kind: 'guarded', path: '/api/b2b/bookings/confirm-settlement', action: 'marketplace.escrow.confirm' },
  { kind: 'guarded', path: '/api/b2b/pilot-dashboard', action: 'founder.pilot.read' },
];

assertRegistryIsSound({ routes: ROUTES });

/** The membership store used by this deployment. Replaced in tests. */
let membershipStore: MembershipStore | null = null;

export function setMembershipStore(store: MembershipStore | null): void {
  membershipStore = store;
}

/** The verifier, injected by the environment that knows how to check a token. */
let verifier: Verifier | null = null;

export function setVerifier(candidate: Verifier | null): void {
  verifier = candidate;
}

/**
 * Builds the real verifier from the environment, or null when unconfigured.
 *
 * Cached per pair of values rather than in a single slot, because a deployment's
 * configuration is fixed and a test's is not: a single cache would let one
 * request's configuration answer another's, so a test with no configuration could
 * be handed the verifier an earlier test built.
 */
const environmentVerifiers = new Map<string, Verifier>();

function environmentVerifierFor(env: Env): Verifier | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (typeof teamDomain !== 'string' || teamDomain.trim() === '') return null;
  if (typeof audience !== 'string' || audience.trim() === '') return null;

  const key = `${teamDomain}\u0000${audience}`;
  const existing = environmentVerifiers.get(key);
  if (existing !== undefined) return existing;

  const built = accessTokenVerifier({ teamDomain, audience });
  environmentVerifiers.set(key, built);
  return built;
}

/**
 * The verifier for this request, falling back to one built from the environment.
 *
 * The injected `verifier` wins because that is how a test substitutes its own
 * without a key set to publish. A deployment never sets it, so the environment
 * verifier is the only path it has — which is what this fallback exists for.
 */
function verifierForEnvironment(env: Env): Verifier | null {
  return verifier ?? environmentVerifierFor(env);
}

interface Env {
  APP_ENV?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_IDENTITY_SUBJECT?: string;
  DEV_IDENTITY?: string;
  DB?: unknown;
  [key: string]: unknown;
}

/**
 * The part of the Worker execution context this file uses.
 *
 * Declared here rather than taken from `@cloudflare/workers-types`, because the
 * only member read is `access`, and only to ask whether the runtime provided it.
 * Depending on the full platform type set for one optional field would put a
 * version pin on the whole Worker API.
 *
 * `access` is optional because the published documentation says the Static Assets
 * router Worker does not forward it to this Worker — which is exactly the
 * question `/api/whoami` exists to answer on a real deployment.
 */
interface WorkerContext {
  access?: unknown;
}

/** The D1 binding this Worker reads. One binding per environment. */
const BINDING_BY_ENVIRONMENT: Readonly<Record<string, string>> = {
  local: 'sadec_demo',
  development: 'sadec_demo',
  test: 'sadec_test',
  demo: 'sadec_demo',
  pilot: 'sadec_pilot',
};

function databaseFor(env: Env): D1Like | null {
  const environment = (env.APP_ENV ?? '').trim().toLowerCase();
  const name = BINDING_BY_ENVIRONMENT[environment];
  // An unset or unrecognised environment has no binding. It is not `local` by
  // default: a deployment that failed to state its environment must not read the
  // demo database, which is the separation §3 asks for. `local` is an explicit
  // value, never the fallback.
  if (name === undefined) return null;
  const binding = env[name];
  if (isD1Like(binding)) return binding as D1Like;
  if (
    (environment === 'development' || environment === 'local' || environment === 'test') &&
    isD1Like(env.DB)
  ) {
    return env.DB as D1Like;
  }
  return null;
}

/**
 * The membership store for this environment's binding, or null when the binding
 * is absent.
 *
 * Returned as null rather than constructed over a missing database so the route
 * refuses instead of running a query that cannot work.
 */
function d1MembershipStoreFor(env: Env): MembershipStore | null {
  const db = databaseFor(env);
  return db === null ? null : d1MembershipStore(db);
}

function isD1Like(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { prepare?: unknown };
  return typeof candidate.prepare === 'function';
}

/**
 * Resolves the identity for a request.
 *
 * In local and test this is the labelled demo identity. Everywhere else it is
 * the verified Access token, and a request with no valid token has no identity.
 * There is no third path that produces one.
 */
async function resolveIdentity(
  request: Request,
  env: Env,
): Promise<{ accessSubject: string; email: string | null; demo: boolean } | null> {
  const demo = resolveDevIdentity(env.APP_ENV, env.DEV_IDENTITY_SUBJECT ?? env.DEV_IDENTITY);
  if (demo !== null) {
    return {
      accessSubject: demo.accessSubject,
      email: demo.email,
      demo: true,
    };
  }

  // The verifier comes from the environment when none was injected. Without it
  // there is no way to check a token, so there is no identity — which is a
  // refusal, never a guess. Missing `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` lands here,
  // which is why the deploy command insists on both before publishing.
  const tokenVerifier = verifierForEnvironment(env);
  if (tokenVerifier === null) return null;

  const verified = await tokenVerifier(request.headers.get('Cf-Access-Jwt-Assertion'));
  if (verified === null) return null;
  return { accessSubject: verified.accessSubject, email: verified.email, demo: false };
}

/** Handles an API request, refusing anything the registry does not open. */
async function handleApi(
  request: Request,
  env: Env,
  ctx: WorkerContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/whoami') {
    return handleWhoami(env, ctx);
  }

  const route = ROUTES.find((entry) => entry.path === path);

  if (route === undefined) {
    // Unknown path. This is deliberately not a 404 that says whether the path
    // might exist behind some auth: it is simply not a route.
    return new Response(JSON.stringify({ error: 'Không tìm thấy đường dẫn.' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  if (route.kind === 'public') {
    switch (route.path) {
      case '/api/health':
        return handleHealth(env);
      case '/api/public/catalog':
        return handlePublicCatalog(databaseFor(env), url.origin, url.searchParams);
      case '/api/schema':
        return handlePublicSchema();
      case '/api/discover':
        return handlePublicDiscover(databaseFor(env), url.origin);
      default:
        return new Response(JSON.stringify({ error: 'Chưa triển khai.' }), {
          status: 501,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
    }
  }

  // Guarded. Without a store there is no way to resolve a membership, and
  // failing closed is the only honest answer.
  //
  // The store is built from this environment's binding on first use rather than
  // injected from outside, so a route cannot be reached through a store that was
  // never resolved. A test injects its own by calling setMembershipStore, and the
  // injected one wins — which is how the authorization tests exercise the
  // chokepoint without a database.
  const store = membershipStore ?? d1MembershipStoreFor(env);
  if (store === null) {
    return forbidden('Hệ thống chưa sẵn sàng xử lý yêu cầu này.');
  }

  const identity = await resolveIdentity(request, env);
  const context = contextFromRequest(identity, url.searchParams);
  // Whether this session is the dev identity, needed below to label the banner.
  const demoSession = identity?.demo ?? false;

  // The session route is the one guarded request the client cannot scope, and
  // that is the point: naming a workspace is what it answers. So the workspace
  // comes from the caller's own memberships, and the role is resolved through
  // `authorize` in the chosen workspace like every other action.
  if (route.path === '/api/session') {
    return handleSessionRoute(identity, env, store, context.workspaceId);
  }

  // A write also proves where it came from. §6 asks for origin checking on
  // mutations. This asks `Sec-Fetch-Site` instead of `Origin`, because `Origin`
  // is a forbidden request-header name: a browser sets it itself and strips it
  // from a `fetch` init, so a same-origin POST from the app carries no such
  // header and an exact-match rule refuses every real save. `Sec-Fetch-Site` is
  // sent by the browser on every request it makes and a page cannot forge it, so
  // it still refuses a cross-site mutation.
  if (request.method !== 'GET' && request.method !== 'HEAD' && !sentFromSameOrigin(request)) {
    return forbidden('Yêu cầu bị từ chối do nguồn gửi không khớp.');
  }

  const result = await authorize(store, {
    accessSubject: context.identity?.accessSubject ?? null,
    action: route.action,
    workspaceId: context.workspaceId,
  });

  if (result.kind === 'denied') {
    return result.reason === 'no_identity'
      ? unauthorized()
      : forbidden(denialMessage(result.reason));
  }

  const db = databaseFor(env);
  if (db === null) {
    return forbidden('Hệ thống chưa sẵn sàng xử lý yêu cầu này.');
  }

  const workspaceId = result.authorization.workspaceId;
  const role = result.authorization.role;
  const actorId = result.authorization.identityId;
  const accessSubject = result.authorization.accessSubject;

  // A record shared between two workspaces (a B2B booking has a buyer and a
  // nursery; an OPC agreement names a target workspace) needs one more answer
  // than "may this caller act in the workspace the request named": may they
  // act in the *other* party's workspace. Both questions go to the chokepoint.
  // `authorizeWorkspace` is a fresh `authorize` call for this route's action,
  // so a membership revoked mid-session denies the next request that relies on
  // it; `accessibleWorkspaceIds` is the list form, read once per request for
  // scoping a query, and always includes the workspace already authorized.
  let accessibleCache: Promise<readonly string[]> | null = null;
  const accessibleWorkspaceIds = (): Promise<readonly string[]> => {
    accessibleCache ??= authorizedWorkspaces(store, { accessSubject, action: route.action }).then(
      (list) => {
        const ids = list.map((m) => m.workspaceId);
        return ids.includes(workspaceId) ? ids : [workspaceId, ...ids];
      },
    );
    return accessibleCache;
  };
  const authorizeWorkspace = async (candidate: string): Promise<boolean> => {
    if (candidate === workspaceId) return true;
    const check = await authorize(store, { accessSubject, action: route.action, workspaceId: candidate });
    return check.kind === 'authorized';
  };

  const ops = { workspaceId, db };
  const opsActor = { workspaceId, actorId, role, db, demo: demoSession };
  const founderCtx = {
    workspaceId,
    actorId,
    role,
    db,
    appEnv: (env.APP_ENV ?? '').trim().toLowerCase(),
    accessibleWorkspaceIds,
    authorizeWorkspace,
  };
  // The account a buyer pays into is deployment configuration. Unset means no
  // QR is offered at all: a placeholder account in code would ask a buyer to
  // send money to an account this platform does not hold.
  const b2bCtx = {
    workspaceId,
    role,
    actorId,
    db,
    accessibleWorkspaceIds,
    authorizeWorkspace,
    escrowAccount: escrowAccountFrom(env as unknown as Record<string, unknown>),
  };

  // The body is read once, here, so the idempotency layer can hash the bytes
  // the handler will parse — not a second copy of them.
  const rawText = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();

  const parseJsonBody = async (): Promise<
    { ok: true; body: unknown; byteLength: number } | { ok: false; response: Response }
  > => {
    try {
      const byteLength = new TextEncoder().encode(rawText).byteLength;
      const body = JSON.parse(rawText);
      return { ok: true, body, byteLength };
    } catch {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: 'Yêu cầu cần gửi JSON hợp lệ.' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      };
    }
  };

  const dispatch = async (): Promise<Response> => {
  switch (route.path) {
    case '/api/products':
      return handleListProducts(ops);
    case '/api/products/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateProduct(ops, parsed.body);
    }
    case '/api/customers':
      return handleListCustomers(ops);
    case '/api/customers/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateCustomer(ops, parsed.body);
    }
    case '/api/quote-drafts':
      return handleListQuoteDrafts(ops);
    case '/api/quote-drafts/save': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleSaveQuoteDraft(ops, parsed.body);
    }
    // Phase 2 routes
    case '/api/today':
    case '/api/ops/today':
      return handleTodaySummary(ops);
    case '/api/quotes/chains':
    case '/api/quote-chains':
      return handleListQuoteChains(ops);
    case '/api/quotes/create':
    case '/api/quote-chains/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateQuoteChain(ops, parsed.body);
    }
    case '/api/quotes/save-draft':
    case '/api/quote-revisions/save-draft': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleSaveDraftRevision(ops, parsed.body);
    }
    case '/api/quotes/issue':
    case '/api/quote-revisions/issue': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleIssueRevision(ops, parsed.body);
    }
    case '/api/quotes/revise':
    case '/api/quote-revisions/revise': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleReviseQuote(ops, parsed.body);
    }
    case '/api/quotes/accept':
    case '/api/quote-revisions/accept': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleAcceptRevision(opsActor, parsed.body);
    }
    case '/api/quotes/printable':
    case '/api/quote-revisions/print':
      return handlePrintableQuote(opsActor, url.searchParams);
    case '/api/orders':
      return handleListOrders(ops);
    case '/api/orders/transition': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleTransitionOrder(ops, parsed.body);
    }
    case '/api/orders/cancel': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCancelOrder(opsActor, parsed.body);
    }
    case '/api/receipts':
      return handleListReceipts(ops, url.searchParams);
    case '/api/receipts/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateReceipt(opsActor, parsed.body);
    }
    case '/api/receipts/confirm': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleConfirmReceipt(opsActor, parsed.body);
    }
    case '/api/receipts/reverse': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleReverseReceipt(opsActor, parsed.body);
    }
    case '/api/deliveries':
      return handleListDeliveries(ops);
    case '/api/deliveries/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateDelivery(opsActor, parsed.body);
    }
    case '/api/deliveries/override': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleOverrideDelivery(opsActor, parsed.body);
    }
    case '/api/deliveries/update-status':
    case '/api/deliveries/status': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleUpdateDeliveryStatus(opsActor, parsed.body);
    }
    case '/api/tasks':
    case '/api/follow-up-tasks':
      return handleListFollowUpTasks(ops, url.searchParams);
    case '/api/tasks/create':
    case '/api/follow-up-tasks/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateFollowUpTask(ops, parsed.body);
    }
    case '/api/tasks/update':
    case '/api/follow-up-tasks/update':
    case '/api/follow-up-tasks/status': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleUpdateFollowUpTask(ops, parsed.body);
    }
    // Phase 3 routes
    case '/api/founder/interviews':
      return handleListInterviews(founderCtx);
    case '/api/founder/interviews/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateOrUpdateInterview(founderCtx, parsed.body);
    }
    case '/api/founder/interviews/import-preview': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handlePreviewImportInterviews(founderCtx, parsed.body, parsed.byteLength);
    }
    case '/api/founder/interviews/import-apply': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleApplyImportInterviews(founderCtx, parsed.body, parsed.byteLength);
    }
    case '/api/founder/interviews/export':
      return handleExportInterviews(founderCtx, url.searchParams);
    case '/api/founder/config':
      return handleGetConfigAndProposals(founderCtx);
    case '/api/founder/config/propose':
    case '/api/founder/proposals/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateProposal(founderCtx, parsed.body);
    }
    case '/api/founder/config/apply':
    case '/api/founder/proposals/apply': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleApplyProposal(founderCtx, parsed.body);
    }
    case '/api/founder/config/rollback': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleRollbackConfig(founderCtx, parsed.body);
    }
    case '/api/founder/economics':
      return handleRunEconomics(founderCtx, url.searchParams);
    case '/api/founder/opc/ledger':
      return handleListOpcLedger(founderCtx, url.searchParams);
    case '/api/founder/opc/agreements/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateOpcAgreement(founderCtx, parsed.body);
    }
    case '/api/founder/opc/obligations/record': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleRecordOpcObligation(founderCtx, parsed.body);
    }
    case '/api/founder/opc/receipts/confirm': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleConfirmOpcReceipt(founderCtx, parsed.body);
    }
    case '/api/founder/opc/credits/apply': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleApplyPilotCredit(founderCtx, parsed.body);
    }
    case '/api/b2b/lots':
      return handleListLots(b2bCtx, url.searchParams);
    case '/api/b2b/lots/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateLot(b2bCtx, parsed.body);
    }
    case '/api/b2b/bookings':
      return handleListBookings(b2bCtx);
    case '/api/b2b/bookings/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateBooking(b2bCtx, parsed.body);
    }
    case '/api/b2b/bookings/confirm-deposit': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleConfirmDeposit(b2bCtx, parsed.body);
    }
    case '/api/b2b/hub-trips':
      return handleListHubTrips(b2bCtx);
    case '/api/b2b/hub-trips/create': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleCreateHubTrip(b2bCtx, parsed.body);
    }
    case '/api/b2b/hub-packages/verify': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleVerifyHubPackage(b2bCtx, parsed.body);
    }
    case '/api/b2b/bookings/inspect-and-settle': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleInspectAndSettle(b2bCtx, parsed.body);
    }
    case '/api/b2b/bookings/confirm-settlement': {
      const parsed = await parseJsonBody();
      if (!parsed.ok) return parsed.response;
      return handleConfirmSettlement(b2bCtx, parsed.body);
    }
    case '/api/b2b/pilot-dashboard':
      return handlePilotDashboard(b2bCtx);
    default:
      // A route in the registry with no handler is a build-time mistake, not a
      // runtime one. It is refused rather than assumed reachable.
      return new Response(JSON.stringify({ error: 'Chưa triển khai.' }), {
        status: 501,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
  }
  };

  // A mutation carrying an `Idempotency-Key` runs at most once per
  // (workspace, route, key, body); a retry gets the stored answer. Reads carry
  // no key and the layer is a pass-through for them. The key is honoured only
  // after identity, origin and authorization: a replayed answer is still an
  // answer this caller was entitled to.
  // A handler that throws past this point has already been authorized, so the
  // fault is the write itself: a constraint the database raised is a lost race
  // (409, re-read and retry), anything else is a 500 that names no table or
  // stack frame. Neither is a 403 — the caller was allowed; the write failed.
  const guarded = (): Promise<Response> =>
    dispatch().catch((thrown: unknown) =>
      responseForThrown(thrown, 'Hệ thống chưa xử lý được yêu cầu này, vui lòng thử lại.'),
    );
  if (request.method === 'GET' || request.method === 'HEAD') return guarded();
  return withIdempotency({
    db,
    workspaceId,
    actionPath: route.path,
    key: request.headers.get(IDEMPOTENCY_HEADER),
    rawBody: rawText,
    run: guarded,
  });
}

/**
 * Answers "who am I acting as, and in which workspace".
 *
 * This is the one route a client cannot scope, because naming a workspace is
 * what it answers — so the workspace comes from the caller's own live
 * memberships and from nowhere else. A caller with none is refused exactly as
 * any other unauthorized request is, rather than being handed a default.
 *
 * Where a caller holds several, the first is chosen — the membership query is
 * ordered by `granted_at, workspace_id`, so that is the earliest-granted
 * membership and, among equal timestamps, the lowest workspace id. The answer is
 * therefore a property of the database rather than of the order the rows
 * happened to arrive in, and a workspace switcher is a later phase's work.
 *
 * The role is still resolved by `authorize`, in the chosen workspace, so this
 * route gains no permission it did not already have — it only learns which
 * workspace to ask about.
 */
async function handleSessionRoute(
  identity: { accessSubject: string; email: string | null; demo: boolean } | null,
  env: Env,
  store: MembershipStore,
  requestedWorkspaceId: string | null = null,
): Promise<Response> {
  if (identity === null) return unauthorized();

  // The list is resolved by the chokepoint for `session.read`, so it holds the
  // workspaces this caller may open a session in and nothing else — not every
  // membership row, and never another identity's.
  const memberships = await authorizedWorkspaces(store, {
    accessSubject: identity.accessSubject,
    action: 'session.read',
  });
  const chosen =
    (requestedWorkspaceId !== null
      ? memberships.find((m) => m.workspaceId === requestedWorkspaceId)
      : undefined) ?? memberships[0];
  if (chosen === undefined) {
    // A verified identity holding no live membership has no workspace to work
    // in, and no role to report. That is a refusal, not an empty session.
    return forbidden('Bạn không thuộc workspace nào.');
  }

  const result = await authorize(store, {
    accessSubject: identity.accessSubject,
    action: 'session.read',
    workspaceId: chosen.workspaceId,
  });
  if (result.kind === 'denied') {
    return result.reason === 'no_identity'
      ? unauthorized()
      : forbidden(denialMessage(result.reason));
  }

  const db = databaseFor(env);
  if (db === null) {
    return forbidden('Hệ thống chưa sẵn sàng xử lý yêu cầu này.');
  }

  return handleSession({
    db,
    workspaceId: result.authorization.workspaceId,
    role: result.authorization.role,
    canSwitchWorkspace: memberships.length > 1,
    memberships,
    identity,
  });
}

/**
 * The development probe.
 *
 * It answers exactly one question — is `ctx.access` present in this Worker? —
 * because the published documentation says the Static Assets router Worker does
 * not forward it, and the only way to know for this deployment is to ask. The
 * answer is written into `docs/DECISIONS.md` rather than left as folklore.
 *
 * It returns a single boolean and nothing else: no header, no subject, no email,
 * no team domain, no audience tag and no role. An unauthenticated caller learns
 * whether a framework object exists and nothing about this deployment's
 * authentication.
 *
 * Registered only in local and test, so a deployment returns the same 404 every
 * unknown path returns.
 */
function handleWhoami(env: Env, ctx: WorkerContext): Response {
  const isDevelopment = resolveDevIdentity(env.APP_ENV, env.DEV_IDENTITY_SUBJECT) !== null;
  if (!isDevelopment) {
    return new Response(JSON.stringify({ error: 'Không tìm thấy đường dẫn.' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  // Reading `access` off the runtime's execution context rather than off
  // `globalThis`, because that is where the platform puts it. If a future runtime
  // propagates it, this reads the propagated truth instead of a stand-in.
  const access = (ctx as { access?: unknown }).access;
  return new Response(
    JSON.stringify({
      access_present: access !== undefined && access !== null,
      note: 'development probe only',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
}

/**
 * Whether the browser says this request came from this origin.
 *
 * `Sec-Fetch-Site` is a forbidden header a page cannot set, so unlike `Origin`
 * it is a statement by the browser rather than by the client. `same-origin` is
 * the case the app's own saves arrive with; `same-site` covers a subdomain of the
 * same registrable site, which is the Worker's own hostname and nothing else, so
 * it is accepted. `cross-site` is what a form post from elsewhere looks like, and
 * `none` means a request the browser did not make from a page — a mutation from
 * there is refused.
 */
function sentFromSameOrigin(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === null) return false;
  return site === 'same-origin' || site === 'same-site';
}

function handleHealth(env: Env): Response {
  return new Response(
    JSON.stringify({ status: 'ok', env: env.APP_ENV ?? 'local' }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

/**
 * The membership store over D1.
 *
 * Reads the membership for a subject in a workspace, which is the one question
 * `authorize` asks. A revoked row returns as present-but-revoked so the
 * chokepoint can deny without the row being deleted and its history lost.
 *
 * The role is read from a column whose CHECK constraint allows only the three
 * roles §6 defines, so a cast here is a cast to a type the database already
 * guarantees. It is written as a check-and-throw rather than an unchecked
 * assertion, so a future migration that widens that column fails loudly here
 * instead of widening a permission silently.
 */
export function d1MembershipStore(db: D1Like): MembershipStore {
  const roles = new Set<Role>([
    'founder_admin',
    'workspace_owner',
    'workspace_operator',
  ]);

  /**
   * Reads a role the database claims, refusing one this build does not know.
   *
   * A CHECK constraint on the column allows only the three roles §6 defines, so
   * a cast here is a cast to a type the database already guarantees. It is
   * written as a check rather than an assertion so a migration that widens the
   * column fails here instead of silently widening a permission.
   */
  const knownRole = (value: string): Role => {
    if (!roles.has(value as Role)) {
      throw new Error(
        `The database holds a role this build does not know: ${value}. ` +
          'A migration added a role without updating the permission table.',
      );
    }
    return value as Role;
  };

  return {
    async findBySubject(accessSubject, workspaceId) {
      const row = await db
        .prepare(
          `SELECT m.identity_id AS identity_id, m.role AS role, m.revoked_at AS revoked_at
             FROM memberships m
             JOIN identities i ON i.id = m.identity_id
            WHERE i.access_sub = ? AND m.workspace_id = ?`,
        )
        .bind(accessSubject, workspaceId)
        .first<{ identity_id: string; role: string; revoked_at: string | null }>();

      if (row === null) return null;

      return {
        identityId: row.identity_id,
        role: knownRole(row.role),
        revokedAt: row.revoked_at,
      };
    },

    async listBySubject(accessSubject) {
      const { results } = await db
        .prepare(
          `SELECT m.workspace_id AS workspace_id, m.role AS role
             FROM memberships m
             JOIN identities i ON i.id = m.identity_id
            WHERE i.access_sub = ? AND m.revoked_at IS NULL
            ORDER BY m.granted_at, m.workspace_id`,
        )
        .bind(accessSubject)
        .all<{ workspace_id: string; role: string }>();

      return results.map((row) => ({
        workspaceId: row.workspace_id,
        role: knownRole(row.role),
      }));
    },
  };
}

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: WorkerContext,
  ): Promise<Response> | Response {
    const url = new URL(request.url);

    // The public machine-readable surface is generated from D1 on every request
    // (see src/ops/public-documents.ts). It is answered here, before the assets
    // binding, so `wrangler.jsonc`'s `run_worker_first` list and this branch are
    // the one place that decides what is public prose and what is an API.
    if (isPublicDocumentPath(url.pathname)) {
      const method = request.method;
      if (method !== 'GET' && method !== 'HEAD') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { allow: 'GET, HEAD' },
        });
      }
      // A document that could not be built is a `503` for the same reason a
      // failed read is: `200` would say the catalogue is empty. The message is
      // Vietnamese and carries nothing internal — no path, table or stack.
      return handlePublicDocument(databaseFor(env), url.pathname, url.origin).catch(() =>
        new Response(`${CATALOG_UNAVAILABLE_MESSAGE}\n`, {
          status: 503,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'retry-after': '60',
          },
        }),
      );
    }

    if (url.pathname.startsWith('/api/')) {
      // Everything the handler throws lands here, because a fault that escapes
      // `fetch` as a rejection is not a closed refusal: the runtime answers 500
      // with its own English page, and the operator gets nothing they can read.
      // That is the ordinary pilot-after-deploy state — a database binding with
      // no schema behind it — so it is converted here rather than left to the
      // runtime.
      return handleApi(request, env, ctx).catch(() =>
        forbidden('Hệ thống chưa sẵn sàng xử lý yêu cầu này.'),
      );
    }
    return new Response('Not found', { status: 404 });
  },
};
