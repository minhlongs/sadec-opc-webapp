/**
 * The browser's only way to reach the API.
 *
 * Two rules this file exists to keep. The workspace travels as a query parameter
 * and comes from the session the server resolved, so no screen picks one — a UI
 * that chose its own workspace would be a UI that could ask for another one. And
 * a total is never computed here: the client can display a preview but the value
 * that counts is the one the server returns from `/api/quote-drafts/save`.
 */

import type { QuoteLineDraft } from '../ops/catalog.ts';

/** The session the server resolved. Display data; permission stays server-side. */
export interface Session {
  accessSubject: string;
  email: string | null;
  displayName: string | null;
  role: 'founder_admin' | 'workspace_owner' | 'workspace_operator';
  workspaceId: string;
  demo: boolean;
  demoLabel: string | null;
}

export interface Product {
  id: string;
  name: string;
  species: string | null;
  size_class: string | null;
  grade: string | null;
  price_vnd: number;
  unit: string;
  stock_note: string | null;
}

export interface Customer {
  id: string;
  workspace_id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
}

export interface PricedLine {
  product_id: string;
  product_name: string;
  unit: string;
  unit_price_vnd: number;
  quantity: number;
  line_total_vnd: number;
  note: string | null;
}

export interface QuoteDraft {
  id: string;
  reference: string;
  customer_id: string;
  status: string;
  subtotal_vnd: number;
  lines: PricedLine[];
  note: string | null;
  updated_at: string;
}

export interface QuoteDraftInput {
  customer_id: string;
  reference: string;
  lines: QuoteLineDraft[];
  note: string | null;
}

/**
 * A call that did not get a usable answer.
 *
 * `status` is 0 for a network failure, which §5's offline state needs to tell
 * apart from a 401 or a 400 — a form must not be wiped because the operator
 * walked out of wifi range.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const API = '/api';

/** Thrown when a session has no workspace to scope a request to. */
function requireWorkspace(workspaceId: string | undefined): string {
  if (workspaceId === undefined || workspaceId.trim() === '') {
    throw new ApiError('Chưa xác định được workspace của phiên làm việc.', 0);
  }
  return workspaceId;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim() !== '') return body.error;
  } catch {
    // A refusal with a non-JSON body still has a status, which is enough.
  }
  return `Yêu cầu thất bại (${response.status}).`;
}

/**
 * Reads a JSON body, and reports a body that is not JSON in Vietnamese.
 *
 * A 200 whose body is not JSON is not hypothetical: Access answers an
 * unauthenticated request with an HTML login page, so the browser can be handed a
 * success status and a page. Letting `response.json()` throw leaks its
 * `SyntaxError` — English text quoting the HTML — into a panel the operator
 * reads, which says nothing they can act on.
 *
 * The status is kept, because a 200 here and a 500 mean different things to
 * whoever debugs it.
 */
async function readJsonBody<T>(
  response: Response,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const text = await response.text();
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return {
      ok: false,
      message:
        response.status === 200
          ? 'Máy chủ trả về nội dung không phải dữ liệu. Phiên làm việc có thể đã hết hạn — thử lại.'
          : `Yêu cầu thất bại (${response.status}).`,
    };
  }
}

async function request<T>(
  path: string,
  workspaceId: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${API}${path}?workspace_id=${encodeURIComponent(workspaceId)}`;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // A failed fetch throws in the browser rather than returning a status, so
    // the offline case is caught here and reported as status 0.
    throw new ApiError('Mất kết nối. Kiểm tra mạng rồi thử lại.', 0);
  }

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }

  const parsed = await readJsonBody<T>(response);
  if (!parsed.ok) {
    throw new ApiError(parsed.message, response.status);
  }
  return parsed.value;
}

/**
 * A mutation sends nothing extra to prove where it came from.
 *
 * The Worker reads `Sec-Fetch-Site`, a header the browser sets itself and a page
 * cannot forge, so a request built here has nothing to add. An `Origin` header
 * set from script is dropped by the browser before the request leaves, because
 * `Origin` is a forbidden request-header name — which is why this function used
 * to look like it was standing a guard and was standing nothing.
 */
function mutationInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

export async function fetchSession(): Promise<Session> {
  // The session is the one request that cannot carry a workspace parameter,
  // because asking for one is what it answers. The Worker resolves the
  // workspace from the caller's own membership.
  let response: Response;
  try {
    response = await fetch(`${API}/session`);
  } catch {
    throw new ApiError('Mất kết nối. Kiểm tra mạng rồi thử lại.', 0);
  }
  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }
  const parsed = await readJsonBody<{ session: Session }>(response);
  if (!parsed.ok) {
    throw new ApiError(parsed.message, response.status);
  }
  return parsed.value.session;
}

export function fetchProducts(
  workspaceId: string,
): Promise<{ products: Product[] }> {
  return request<{ products: Product[] }>('/products', workspaceId);
}

export function fetchCustomers(
  workspaceId: string,
): Promise<{ customers: Customer[] }> {
  return request<{ customers: Customer[] }>('/customers', workspaceId);
}

export function fetchQuoteDrafts(
  workspaceId: string,
): Promise<{ drafts: QuoteDraft[] }> {
  return request<{ drafts: QuoteDraft[] }>('/quote-drafts', workspaceId);
}

export function saveQuoteDraft(
  workspaceId: string,
  input: QuoteDraftInput,
): Promise<{ draft: QuoteDraft }> {
  return request<{ draft: QuoteDraft }>(
    '/quote-drafts/save',
    workspaceId,
    mutationInit(input),
  );
}
