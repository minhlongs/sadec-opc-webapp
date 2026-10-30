/**
 * The error envelope every API refusal uses, and the stable codes a client may
 * branch on.
 *
 * `error` stays a Vietnamese sentence for the person reading the screen. `code`
 * exists for the program reading the response: a UI that must tell "the lot
 * changed under you, reload" from "you may not do this" cannot do so by
 * matching prose, and prose is the one part of a message that is free to
 * change. The set is closed and small on purpose — a new code is a new client
 * behaviour, and gets added here with the branch that needs it.
 */
export type ApiErrorCode =
  /** The body failed validation; `error` names the field. 400. */
  | 'validation'
  /** No verified identity. 401. */
  | 'unauthorized'
  /** A verified identity that may not do this, or not here. 403. */
  | 'forbidden'
  /** The record is not visible to this caller — absent or out of reach. 404. */
  | 'not_found'
  /** The record is not in a state this action applies to. 409. */
  | 'invalid_state'
  /** A concurrent change won; the caller must re-read before retrying. 409. */
  | 'conflict'
  /** The client acted on a lot revision the server no longer holds. 409. */
  | 'revision_conflict'
  /** Not enough units left to reserve the quantity asked for. 409. */
  | 'insufficient_stock'
  /** Same idempotency key, different payload. 409. */
  | 'idempotency_conflict'
  /** Same idempotency key, first request still running. 409. */
  | 'idempotency_in_progress'
  /** The database refused or the deployment is not ready. 500/503. */
  | 'unavailable'
  /**
   * The public catalogue could not be read, so it is unknown whether anything
   * is published. 503. Distinct from an empty catalogue, which is a `200`: a
   * client that treats this as "no lots" tells a buyer the nursery is out of
   * stock when the truth is that nobody could look. The agent bridge and the
   * discovery documents both branch on it.
   */
  | 'catalog_unavailable';

/**
 * The code a status implies when a refusal carries none of its own. The ops
 * and founder transactions return `{ message, status }` refusals; this gives
 * their responses a code without each call site choosing one.
 */
export function codeForStatus(status: number): ApiErrorCode | undefined {
  switch (status) {
    case 400:
      return 'validation';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    default:
      return status >= 500 ? 'unavailable' : undefined;
  }
}

/** The response for a `{ kind: 'refused', message, status }` result. */
export function refusalResponse(refusal: { message: string; status: number; code?: ApiErrorCode }): Response {
  return apiError(refusal.message, refusal.status, refusal.code ?? codeForStatus(refusal.status));
}

/** One shape for every refusal: a sentence, and optionally a code. */
export function apiError(message: string, status: number, code?: ApiErrorCode): Response {
  const body: { error: string; code?: ApiErrorCode } = { error: message };
  if (code !== undefined) body.code = code;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * A domain refusal that already knows its HTTP status and code.
 *
 * Domain modules throw this instead of a bare `Error` so a route can answer
 * without matching on message text, and so anything that is *not* one of
 * these — a constraint the database raised, a bug — is recognisably not a
 * refusal and is reported generically rather than echoed to the client.
 */
export class DomainError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(message: string, status: number, code: ApiErrorCode) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

/** Sentences for the refusals that recur across modules. */
export const GENERIC_MESSAGES = {
  notFound: 'Không tìm thấy bản ghi hoặc bạn không có quyền truy cập.',
  conflict: 'Dữ liệu vừa được thay đổi bởi thao tác khác. Vui lòng tải lại và thử lại.',
  unavailable: 'Hệ thống chưa thể xử lý yêu cầu này. Vui lòng thử lại sau.',
} as const;

/**
 * Turns anything a handler threw into a response.
 *
 * A `DomainError` carries its own answer. A constraint the database raised —
 * UNIQUE, CHECK, FOREIGN KEY — is a concurrent or stale write the SQL guard
 * caught, so it is a 409 the caller can recover from by re-reading. Anything
 * else is logged server-side and answered with a sentence that says nothing
 * about tables, columns or stack frames.
 */
export function responseForThrown(thrown: unknown, fallback: string): Response {
  if (thrown instanceof DomainError) {
    return apiError(thrown.message, thrown.status, thrown.code);
  }
  const text = thrown instanceof Error ? thrown.message : String(thrown);
  if (/UNIQUE constraint|CHECK constraint|FOREIGN KEY constraint|SQLITE_CONSTRAINT/i.test(text)) {
    return apiError(GENERIC_MESSAGES.conflict, 409, 'conflict');
  }
  console.error(`[api] ${fallback}:`, thrown);
  return apiError(fallback, 500, 'unavailable');
}
