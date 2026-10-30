import type { D1Like } from './catalog.ts';
import { apiError } from './api-error.ts';

/**
 * Idempotent POSTs.
 *
 * A booking, a deposit confirmation, a settlement confirmation or a receipt
 * sent twice — because the network dropped the first answer and the person
 * tapped again — must not become two records. The client sends one
 * `Idempotency-Key` per *intent* and reuses it across retries of that intent;
 * the server stores the first response under that key and answers it again.
 *
 * The key is bound to the workspace and the route, so the same string in a
 * different workspace or on a different action is a different key. It is also
 * bound to a hash of the body: the same key with a different payload is a
 * programming error on the client, and is refused with `idempotency_conflict`
 * rather than answered with a response to a request that was never made.
 *
 * Storage is the `idempotency_keys` table from migration 0005. The reservation
 * is one `INSERT OR IGNORE`, and `changes` decides who owns the key: the
 * request that inserted the row runs the handler; a request that found it
 * already there either replays the stored answer, waits (`in_progress`), or is
 * refused. No read-then-insert, so two concurrent retries cannot both run.
 *
 * Only responses below 500 are kept. A handler that failed because the
 * database was unavailable did not do the work, and the next retry must be
 * allowed to.
 */

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** A reservation nobody completed in this long is treated as abandoned. */
const ABANDONED_AFTER_MS = 60_000;

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

interface StoredKey {
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: string | null;
  created_at: string;
}

export interface IdempotentCall {
  db: D1Like;
  workspaceId: string;
  actionPath: string;
  /** The raw header value; `null` means the client asked for no protection. */
  key: string | null;
  /** The request body as text, hashed with the path to bind the key. */
  rawBody: string;
  run: () => Promise<Response>;
  now?: () => Date;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonHeaders(replayed: boolean): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'idempotency-replayed': replayed ? 'true' : 'false',
  };
}

/**
 * Runs `run` at most once per (workspace, path, key, body).
 *
 * Without a key the handler simply runs. With one, the stored answer is
 * returned on a retry, byte for byte, with `Idempotency-Replayed: true`.
 */
export async function withIdempotency(call: IdempotentCall): Promise<Response> {
  if (call.key === null) return call.run();

  const key = call.key.trim();
  if (!KEY_PATTERN.test(key)) {
    return apiError(
      'Idempotency-Key không hợp lệ: cần 8–128 ký tự chữ, số hoặc . _ : -',
      400,
      'validation',
    );
  }

  const nowDate = (call.now ?? (() => new Date()))();
  const now = nowDate.toISOString();
  const hash = await sha256Hex(`${call.actionPath}\n${call.rawBody}`);
  const scope = [call.workspaceId, call.actionPath, key] as const;

  const reserved = await call.db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys
         (workspace_id, action_path, idempotency_key, request_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'in_progress', ?)`,
    )
    .bind(...scope, hash, now)
    .run();

  let owner = reserved.meta.changes === 1;

  if (!owner) {
    const existing = await call.db
      .prepare(
        `SELECT request_hash, status, response_status, response_body, created_at
           FROM idempotency_keys
          WHERE workspace_id = ? AND action_path = ? AND idempotency_key = ?`,
      )
      .bind(...scope)
      .first<StoredKey>();

    if (existing === null) {
      // Deleted between our insert and our read (a failed owner cleaning up).
      // Not worth a retry loop: the client's own retry will take the key.
      return apiError('Yêu cầu trước với cùng khóa vừa kết thúc; vui lòng gửi lại.', 409, 'idempotency_in_progress');
    }

    if (existing.request_hash !== hash) {
      return apiError(
        'Idempotency-Key này đã được dùng cho một yêu cầu có nội dung khác.',
        409,
        'idempotency_conflict',
      );
    }

    if (existing.status === 'completed' && existing.response_status !== null) {
      return new Response(existing.response_body ?? '', {
        status: existing.response_status,
        headers: jsonHeaders(true),
      });
    }

    // in_progress: either a concurrent retry is running it right now, or an
    // earlier attempt died without completing. Take over only the latter, and
    // only by winning a conditional update.
    const abandonedBefore = new Date(nowDate.getTime() - ABANDONED_AFTER_MS).toISOString();
    const takeover = await call.db
      .prepare(
        `UPDATE idempotency_keys SET created_at = ?
          WHERE workspace_id = ? AND action_path = ? AND idempotency_key = ?
            AND status = 'in_progress' AND created_at < ?`,
      )
      .bind(now, ...scope, abandonedBefore)
      .run();
    if (takeover.meta.changes !== 1) {
      return apiError(
        'Yêu cầu với cùng khóa đang được xử lý; vui lòng chờ kết quả thay vì gửi lại.',
        409,
        'idempotency_in_progress',
      );
    }
    owner = true;
  }

  let response: Response;
  try {
    response = await call.run();
  } catch (thrown) {
    await release(call.db, scope);
    throw thrown;
  }

  if (response.status >= 500) {
    await release(call.db, scope);
    return response;
  }

  const body = await response.text();
  const completed = await call.db
    .prepare(
      `UPDATE idempotency_keys
          SET status = 'completed', response_status = ?, response_body = ?, completed_at = ?
        WHERE workspace_id = ? AND action_path = ? AND idempotency_key = ? AND status = 'in_progress'`,
    )
    .bind(response.status, body, new Date().toISOString(), ...scope)
    .run();
  if (completed.meta.changes !== 1) {
    // Someone released or took the key while we ran. The work is done; answer
    // it, but do not pretend the stored copy is ours.
    return new Response(body, { status: response.status, headers: jsonHeaders(false) });
  }

  return new Response(body, { status: response.status, headers: jsonHeaders(false) });
}

async function release(db: D1Like, scope: readonly [string, string, string]): Promise<void> {
  await db
    .prepare(
      `DELETE FROM idempotency_keys
        WHERE workspace_id = ? AND action_path = ? AND idempotency_key = ? AND status = 'in_progress'`,
    )
    .bind(...scope)
    .run();
}
