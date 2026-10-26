/**
 * Operations transactions in the database: quote revisions, orders, receipts,
 * deliveries and follow-ups.
 *
 * The arithmetic and the state machines live in `quote-revisions.ts`; this module
 * is the D1 access that persists them. Two consequences shape every function
 * here:
 *
 *   - The server computes every total. A total arriving in a request body is
 *     read and discarded, and the value that persists is the one computed from
 *     unit prices this module read itself.
 *
 *   - A conditional UPDATE that matched zero rows is a refusal, not a success.
 *     D1's `batch()` is a SQL transaction rather than a row lock, so two people
 *     confirming the same receipt interleave; `meta.changes` is what turns the
 *     loser's zero-row update into a 409 instead of a second confirmation.
 */

import {
  canTransition,
  depositRequired,
  priceLines,
  subtotalOfLines,
  totalOfRevision,
  type DeliveryStatus,
  type FollowUpKind,
  type OrderStatus,
  type PriceableLine,
  type QuoteLine,
  type QuoteLineInput,
  type QuoteRevision,
  type QuoteRevisionStatus,
  type TaskStatus,
} from './quote-revisions.ts';
import type { CustomerRow, D1Like, ProductRow } from './catalog.ts';
import { formatVnd, formatVndWithUnit } from '../domain/money.ts';

/** The product columns a quote line needs read, so a price is never guessed. */
export interface ProductForQuote {
  id: string;
  name: string;
  unit: string;
  price_vnd: number;
}

export interface QuoteChainRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  reference: string;
  created_at: string;
  updated_at: string;
}

const REVISION_COLUMNS = `id, chain_id, workspace_id, revision_number, status, lines_json,
              subtotal_vnd, discount_vnd, fees_vnd, total_vnd, valid_until,
              conditions_note, issued_at, accepted_at, created_at, updated_at`;

export interface QuoteRevisionRow {
  id: string;
  chain_id: string;
  workspace_id: string;
  revision_number: number;
  status: string;
  lines_json: string;
  subtotal_vnd: number;
  discount_vnd: number;
  fees_vnd: number;
  total_vnd: number;
  valid_until: string | null;
  conditions_note: string | null;
  issued_at: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderRow {
  id: string;
  workspace_id: string;
  quote_chain_id: string;
  accepted_revision_id: string;
  customer_id: string;
  order_code: string;
  total_vnd: number;
  deposit_required_vnd: number;
  pilot_credit_applied_vnd: number;
  collected_vnd: number;
  refund_owed_vnd: number;
  status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReceiptRow {
  id: string;
  workspace_id: string;
  order_id: string;
  amount_vnd: number;
  status: string;
  reference: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  reversal_reason: string | null;
  reversed_by: string | null;
  reversed_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  id: string;
  workspace_id: string;
  order_id: string;
  scheduled_date: string;
  status: string;
  delivery_address: string;
  under_deposit_override: number;
  override_reason: string | null;
  override_by: string | null;
  assigned_to: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowUpTaskRow {
  id: string;
  workspace_id: string;
  order_id: string | null;
  customer_id: string;
  due_date: string;
  task_kind: string;
  status: string;
  assigned_to: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** An audit row, written beside every state change that §14 asks to survive. */
export interface AuditEventRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  action: string;
  subject_type: string;
  subject_id: string;
  detail: string | null;
  created_at: string;
}

const nowIso = (): string => new Date().toISOString();

const id = (prefix: string): string =>
  `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/**
 * Resolves an actor id that satisfies the schema's foreign keys.
 *
 * `receipts.confirmed_by`, `receipt_events.actor_id`, `deliveries.override_by`
 * and `follow_up_tasks.assigned_to` all reference `identities(id)`, so an actor
 * id that is not an identity in this workspace would abort the batch with a
 * constraint error rather than record the action. The chokepoint supplies a real
 * identity id; this exists so a caller that omits it still records the work
 * against a member of the workspace rather than inventing a stranger.
 */
async function resolveActorId(
  db: D1Like,
  workspaceId: string,
  candidate: string | undefined,
): Promise<string> {
  if (candidate !== undefined && candidate !== '') {
    const found = await db
      .prepare(`SELECT id FROM identities WHERE id = ?`)
      .bind(candidate)
      .first<{ id: string }>();
    if (found !== null) return found.id;
  }

  const member = await db
    .prepare(
      `SELECT identity_id FROM memberships
        WHERE workspace_id = ? AND revoked_at IS NULL
        ORDER BY CASE role WHEN 'workspace_owner' THEN 0 ELSE 1 END, granted_at ASC
        LIMIT 1`,
    )
    .bind(workspaceId)
    .first<{ identity_id: string }>();

  return member?.identity_id ?? 'id-demo-owner';
}

/**
 * Serializes a quote revision row into its domain shape.
 *
 * `lines_json` is parsed here and nowhere else, so the shape a line has inside a
 * revision is decided once. A malformed column is a data error rather than a
 * value to default, so it throws instead of quietly producing an empty list.
 */
export function parseRevision(row: QuoteRevisionRow): QuoteRevision {
  const lines = JSON.parse(row.lines_json) as QuoteLine[];
  if (!Array.isArray(lines)) {
    throw new RangeError(`Quote revision ${row.id} has a lines column that is not a list`);
  }
  return {
    id: row.id,
    chain_id: row.chain_id,
    workspace_id: row.workspace_id,
    revision_number: row.revision_number,
    status: row.status as QuoteRevisionStatus,
    lines,
    subtotal_vnd: row.subtotal_vnd,
    discount_vnd: row.discount_vnd,
    fees_vnd: row.fees_vnd,
    total_vnd: row.total_vnd,
    valid_until: row.valid_until,
    conditions_note: row.conditions_note,
    issued_at: row.issued_at,
    accepted_at: row.accepted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Reads a revision by id, scoped to the workspace. */
export async function readRevision(
  db: D1Like,
  workspaceId: string,
  revisionId: string,
): Promise<QuoteRevisionRow | null> {
  return db
    .prepare(
      `SELECT ${REVISION_COLUMNS}
         FROM quote_revisions
        WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, revisionId)
    .first<QuoteRevisionRow>();
}

/** Reads the newest revision in a chain, which is the one a user edits next. */
export async function readLatestRevision(
  db: D1Like,
  workspaceId: string,
  chainId: string,
): Promise<QuoteRevisionRow | null> {
  return db
    .prepare(
      `SELECT ${REVISION_COLUMNS}
         FROM quote_revisions
        WHERE workspace_id = ? AND chain_id = ?
        ORDER BY revision_number DESC
        LIMIT 1`,
    )
    .bind(workspaceId, chainId)
    .first<QuoteRevisionRow>();
}

/** Reads the accepted revision in a chain, if one exists. */
export async function readAcceptedRevision(
  db: D1Like,
  workspaceId: string,
  chainId: string,
): Promise<QuoteRevisionRow | null> {
  return db
    .prepare(
      `SELECT ${REVISION_COLUMNS}
         FROM quote_revisions
        WHERE workspace_id = ? AND chain_id = ? AND status = 'accepted'`,
    )
    .bind(workspaceId, chainId)
    .first<QuoteRevisionRow>();
}

/**
 * Reads the products named by a set of lines, refusing rather than guessing.
 *
 * A product id that does not resolve to one active row in this workspace is
 * absent from the map, and the caller turns that into a refusal. This is the
 * only place a quote line's unit price comes from.
 */
export async function productsForLines(
  db: D1Like,
  workspaceId: string,
  productIds: readonly string[],
): Promise<Map<string, ProductForQuote>> {
  const found = new Map<string, ProductForQuote>();
  for (const productId of productIds) {
    const row = await db
      .prepare(
        `SELECT id, name, unit, price_vnd FROM products
          WHERE workspace_id = ? AND id = ? AND is_active = 1`,
      )
      .bind(workspaceId, productId)
      .first<ProductForQuote>();
    if (row !== null) found.set(productId, row);
  }
  return found;
}

/** Reads an order by id, scoped to the workspace. */
export async function readOrder(
  db: D1Like,
  workspaceId: string,
  orderId: string,
): Promise<OrderRow | null> {
  return db
    .prepare(
      `SELECT id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
              order_code, total_vnd, deposit_required_vnd, pilot_credit_applied_vnd,
              collected_vnd, refund_owed_vnd, status, note, created_at, updated_at
         FROM orders
        WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, orderId)
    .first<OrderRow>();
}

/** Reads the order in a chain, if one exists. The chain has at most one. */
export async function readOrderForChain(
  db: D1Like,
  workspaceId: string,
  chainId: string,
): Promise<OrderRow | null> {
  return db
    .prepare(
      `SELECT id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
              order_code, total_vnd, deposit_required_vnd, pilot_credit_applied_vnd,
              collected_vnd, refund_owed_vnd, status, note, created_at, updated_at
         FROM orders
        WHERE workspace_id = ? AND quote_chain_id = ?`,
    )
    .bind(workspaceId, chainId)
    .first<OrderRow>();
}

export interface MutationOutcome<T> {
  kind: 'ok';
  value: T;
  message?: string;
  status?: number;
}

export interface Refusal {
  kind: 'refused';
  message: string;
  status: number;
  value?: never;
}

export type Outcome<T> = MutationOutcome<T> | Refusal;

function refused(message: string, status: number): Refusal {
  return { kind: 'refused', message, status };
}

function ok<T>(value: T): MutationOutcome<T> {
  return { kind: 'ok', value };
}

/* -------------------------------------------------------------------------- */
/* Products and customers — the two catalogs a quote draws from                 */
/* -------------------------------------------------------------------------- */

export async function createProduct(
  db: D1Like,
  args: {
    workspaceId: string;
    name: string;
    species?: string | null;
    size_class?: string | null;
    grade?: string | null;
    priceVnd: number;
    unit: string;
    stock_note?: string | null;
  },
): Promise<Outcome<ProductRow>> {
  const productId = id('pd');
  const createdAt = nowIso();

  const saved = await db
    .prepare(
      `INSERT INTO products
         (id, workspace_id, name, species, size_class, grade, price_vnd, unit,
          stock_note, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       RETURNING id, workspace_id, name, species, size_class, grade, price_vnd,
                 unit, stock_note, is_active, created_at, updated_at`,
    )
    .bind(
      productId,
      args.workspaceId,
      args.name,
      args.species ?? null,
      args.size_class ?? null,
      args.grade ?? null,
      args.priceVnd,
      args.unit,
      args.stock_note ?? null,
      createdAt,
      createdAt,
    )
    .first<ProductRow>();

  if (saved === null) return refused('Không tạo được sản phẩm.', 500);
  return ok(saved);
}

export async function createCustomer(
  db: D1Like,
  args: {
    workspaceId: string;
    name: string;
    contactName?: string | null;
    phone?: string | null;
    address?: string | null;
    note?: string | null;
  },
): Promise<Outcome<CustomerRow>> {
  const customerId = id('cu');
  const createdAt = nowIso();

  const saved = await db
    .prepare(
      `INSERT INTO customers
         (id, workspace_id, name, contact_name, phone, address, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, workspace_id, name, contact_name, phone, address, note,
                 created_at, updated_at`,
    )
    .bind(
      customerId,
      args.workspaceId,
      args.name,
      args.contactName ?? null,
      args.phone ?? null,
      args.address ?? null,
      args.note ?? null,
      createdAt,
      createdAt,
    )
    .first<CustomerRow>();

  if (saved === null) return refused('Không tạo được khách hàng.', 500);
  return ok(saved);
}

/* -------------------------------------------------------------------------- */
/* Quote chains and revisions                                                  */
/* -------------------------------------------------------------------------- */

export interface ChainCreation {
  chainId: string;
  revisionId: string;
  revisionNumber: number;
  createdAt: string;
}

export interface QuoteChainView extends QuoteChainRow {
  customer_name: string | null;
  revisions: QuoteRevision[];
}

/**
 * Creates a quote chain with its first draft revision.
 * Supports both:
 *  - 2-arg object: createChainWithDraft(db, { workspaceId, customerId, reference, lines?, discountVnd?, feesVnd?, validUntil?, conditionsNote? })
 *  - alias: createQuoteChain
 */
export async function createChainWithDraft(
  db: D1Like,
  args: {
    workspaceId: string;
    customerId: string;
    reference: string;
    lines?: QuoteLineInput[];
    discountVnd?: number;
    feesVnd?: number;
    validUntil?: string | null;
    conditionsNote?: string | null;
  },
): Promise<Outcome<QuoteChainView & ChainCreation>> {
  const customer = await db
    .prepare(`SELECT id, name FROM customers WHERE workspace_id = ? AND id = ?`)
    .bind(args.workspaceId, args.customerId)
    .first<{ id: string; name: string }>();
  if (customer === null) {
    return refused('Khách không thuộc workspace này.', 400);
  }

  const createdAt = nowIso();
  const chainId = id('qc');
  const revisionId = id('qr');

  let lines: QuoteLine[] = [];
  let subtotal = 0;
  let total = 0;
  const discountVnd = args.discountVnd ?? 0;
  const feesVnd = args.feesVnd ?? 0;

  if (args.lines !== undefined && args.lines.length > 0) {
    const priced = await priceRequestLines(db, args.workspaceId, args.lines);
    if (priced.kind === 'refused') return priced;
    lines = priced.value;
    subtotal = subtotalOfLines(lines);
    total = totalOfRevision(subtotal, discountVnd, feesVnd);
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO quote_chains (id, workspace_id, customer_id, reference, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(chainId, args.workspaceId, args.customerId, args.reference, createdAt, createdAt),
    db
      .prepare(
        `INSERT INTO quote_revisions
           (id, chain_id, workspace_id, revision_number, status, lines_json,
            subtotal_vnd, discount_vnd, fees_vnd, total_vnd, valid_until,
            conditions_note, issued_at, accepted_at, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(
        revisionId,
        chainId,
        args.workspaceId,
        JSON.stringify(lines),
        subtotal,
        discountVnd,
        feesVnd,
        total,
        args.validUntil ?? null,
        args.conditionsNote ?? null,
        createdAt,
        createdAt,
      ),
  ]);

  const rev: QuoteRevision = {
    id: revisionId,
    chain_id: chainId,
    workspace_id: args.workspaceId,
    revision_number: 1,
    status: 'draft',
    lines,
    subtotal_vnd: subtotal,
    discount_vnd: discountVnd,
    fees_vnd: feesVnd,
    total_vnd: total,
    valid_until: args.validUntil ?? null,
    conditions_note: args.conditionsNote ?? null,
    issued_at: null,
    accepted_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };

  return ok({
    id: chainId,
    workspace_id: args.workspaceId,
    customer_id: args.customerId,
    customer_name: customer.name,
    reference: args.reference,
    created_at: createdAt,
    updated_at: createdAt,
    createdAt,
    chainId,
    revisionId,
    revisionNumber: 1,
    revisions: [rev],
  });
}

export const createQuoteChain = createChainWithDraft;

/**
 * Saves a draft revision's lines and money, recomputed by the server.
 * Supports:
 *   - saveDraftRevision(db, { workspaceId, revisionId, lines, discountVnd?, feesVnd?, validUntil?, conditionsNote? })
 *   - saveDraftRevision(db, workspaceId, revisionId, patch)
 */
export async function saveDraftRevision(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        revisionId: string;
        lines: QuoteLineInput[];
        discountVnd?: number;
        feesVnd?: number;
        discount_vnd?: number;
        fees_vnd?: number;
        validUntil?: string | null;
        conditionsNote?: string | null;
        valid_until?: string | null;
        conditions_note?: string | null;
      },
  arg3?: string,
  arg4?: {
    lines: QuoteLineInput[];
    discount_vnd?: number;
    fees_vnd?: number;
    discountVnd?: number;
    feesVnd?: number;
    valid_until?: string | null;
    conditions_note?: string | null;
    validUntil?: string | null;
    conditionsNote?: string | null;
  },
): Promise<Outcome<QuoteRevision>> {
  let workspaceId: string;
  let revisionId: string;
  let linesInput: QuoteLineInput[];
  let discountVnd: number;
  let feesVnd: number;
  let validUntil: string | null = null;
  let conditionsNote: string | null = null;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    revisionId = arg2.revisionId;
    linesInput = arg2.lines;
    discountVnd = arg2.discountVnd ?? arg2.discount_vnd ?? 0;
    feesVnd = arg2.feesVnd ?? arg2.fees_vnd ?? 0;
    validUntil = arg2.validUntil ?? arg2.valid_until ?? null;
    conditionsNote = arg2.conditionsNote ?? arg2.conditions_note ?? null;
  } else {
    workspaceId = arg2;
    revisionId = arg3!;
    linesInput = arg4!.lines;
    discountVnd = arg4!.discount_vnd ?? arg4!.discountVnd ?? 0;
    feesVnd = arg4!.fees_vnd ?? arg4!.feesVnd ?? 0;
    validUntil = arg4!.valid_until ?? arg4!.validUntil ?? null;
    conditionsNote = arg4!.conditions_note ?? arg4!.conditionsNote ?? null;
  }

  const row = await readRevision(db, workspaceId, revisionId);
  if (row === null) return refused('Không tìm thấy báo giá.', 404);
  if (row.status !== 'draft') {
    return refused(
      `Báo giá đã phát hành nên không sửa được. Hãy tạo bản điều chỉnh mới.`,
      409,
    );
  }

  const priced = await priceRequestLines(db, workspaceId, linesInput);
  if (priced.kind === 'refused') return priced;

  const subtotal = subtotalOfLines(priced.value);
  const total = totalOfRevision(subtotal, discountVnd, feesVnd);
  const updatedAt = nowIso();

  const finalValidUntil = validUntil !== null ? validUntil : row.valid_until;
  const finalConditions = conditionsNote !== null ? conditionsNote : row.conditions_note;

  const result = await db
    .prepare(
      `UPDATE quote_revisions
          SET lines_json = ?, subtotal_vnd = ?, discount_vnd = ?, fees_vnd = ?,
              total_vnd = ?, valid_until = ?, conditions_note = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'draft'`,
    )
    .bind(
      JSON.stringify(priced.value),
      subtotal,
      discountVnd,
      feesVnd,
      total,
      finalValidUntil,
      finalConditions,
      updatedAt,
      revisionId,
      workspaceId,
    )
    .run();

  if (result.meta.changes === 0) {
    return refused('Báo giá đã đổi trạng thái, thao tác bị từ chối.', 409);
  }

  const saved = await readRevision(db, workspaceId, revisionId);
  if (saved === null) return refused('Không đọc lại được báo giá vừa lưu.', 500);
  return ok(parseRevision(saved));
}

/**
 * Prices request lines against the workspace's own product table or product_name fallback.
 */
async function priceRequestLines(
  db: D1Like,
  workspaceId: string,
  lines: QuoteLineInput[],
): Promise<Outcome<QuoteLine[]>> {
  const productIds = lines
    .map((l) => l.product_id)
    .filter((pid): pid is string => typeof pid === 'string' && pid !== '');

  const products = await productsForLines(db, workspaceId, productIds);

  const resolved: PriceableLine[] = [];

  for (const line of lines) {
    if (line.product_id && products.has(line.product_id)) {
      const p = products.get(line.product_id)!;
      resolved.push({
        product_id: p.id,
        product_name: p.name,
        unit: p.unit,
        unit_price_vnd: p.price_vnd,
        quantity: line.quantity,
        discount_vnd: line.discount_vnd ?? 0,
        note: line.note ?? null,
      });
    } else if (line.product_name && line.unit_price_vnd !== undefined) {
      resolved.push({
        product_id: line.product_id ?? id('pd'),
        product_name: line.product_name,
        unit: line.unit ?? 'chậu',
        unit_price_vnd: line.unit_price_vnd,
        quantity: line.quantity,
        discount_vnd: line.discount_vnd ?? 0,
        note: line.note ?? null,
      });
    } else {
      return refused('Báo giá có mặt hàng không thuộc workspace này.', 400);
    }
  }

  return ok(priceLines(resolved));
}

/**
 * Issues a draft revision, freezing its snapshot.
 * Supports:
 *   - issueRevision(db, { workspaceId, revisionId, ... })
 *   - issueRevision(db, workspaceId, revisionId, patch?)
 */
export async function issueRevision(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        revisionId: string;
        lines?: QuoteLineInput[];
        discount_vnd?: number;
        fees_vnd?: number;
        discountVnd?: number;
        feesVnd?: number;
        valid_until?: string | null;
        conditions_note?: string | null;
        validUntil?: string | null;
        conditionsNote?: string | null;
      },
  arg3?: string,
  arg4?: {
    lines?: QuoteLineInput[];
    discount_vnd?: number;
    fees_vnd?: number;
    discountVnd?: number;
    feesVnd?: number;
    valid_until?: string | null;
    conditions_note?: string | null;
    validUntil?: string | null;
    conditionsNote?: string | null;
  },
): Promise<Outcome<QuoteRevision>> {
  let workspaceId: string;
  let revisionId: string;
  let patch: typeof arg4;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    revisionId = arg2.revisionId;
    patch = arg2;
  } else {
    workspaceId = arg2;
    revisionId = arg3!;
    patch = arg4;
  }

  const row = await readRevision(db, workspaceId, revisionId);
  if (row === null) return refused('Không tìm thấy báo giá.', 404);
  if (row.status !== 'draft') {
    return refused(`Báo giá đang ở trạng thái "${row.status}", không phát hành lại được.`, 409);
  }

  let linesJson = row.lines_json;
  let subtotal = row.subtotal_vnd;
  let discount = row.discount_vnd;
  let fees = row.fees_vnd;
  let total = row.total_vnd;
  let validUntil = row.valid_until;
  let conditions = row.conditions_note;

  if (patch?.lines !== undefined) {
    const priced = await priceRequestLines(db, workspaceId, patch.lines);
    if (priced.kind === 'refused') return priced;
    linesJson = JSON.stringify(priced.value);
    subtotal = subtotalOfLines(priced.value);
    discount = patch.discount_vnd ?? patch.discountVnd ?? discount;
    fees = patch.fees_vnd ?? patch.feesVnd ?? fees;
    total = totalOfRevision(subtotal, discount, fees);
  }
  if (patch?.valid_until !== undefined || patch?.validUntil !== undefined) {
    validUntil = patch.valid_until ?? patch.validUntil ?? null;
  }
  if (patch?.conditions_note !== undefined || patch?.conditionsNote !== undefined) {
    conditions = patch.conditions_note ?? patch.conditionsNote ?? null;
  }

  const issuedAt = nowIso();

  const result = await db
    .prepare(
      `UPDATE quote_revisions
          SET status = 'issued', lines_json = ?, subtotal_vnd = ?, discount_vnd = ?,
              fees_vnd = ?, total_vnd = ?, valid_until = ?, conditions_note = ?,
              issued_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'draft'`,
    )
    .bind(
      linesJson,
      subtotal,
      discount,
      fees,
      total,
      validUntil,
      conditions,
      issuedAt,
      issuedAt,
      revisionId,
      workspaceId,
    )
    .run();

  if (result.meta.changes === 0) {
    return refused('Báo giá đã đổi trạng thái, thao tác bị từ chối.', 409);
  }

  const issued = await readRevision(db, workspaceId, revisionId);
  if (issued === null) return refused('Không đọc lại được báo giá vừa phát hành.', 500);
  return ok(parseRevision(issued));
}

/**
 * Creates a new revision after an issued one, superseding it.
 * Supports:
 *   - reviseIssued(db, { workspaceId, revisionId?, chainId?, lines?, ... })
 *   - reviseIssued(db, workspaceId, chainId, patch)
 *   - alias: reviseIssuedQuote
 */
export async function reviseIssued(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        revisionId?: string;
        chainId?: string;
        lines?: QuoteLineInput[];
        discountVnd?: number;
        feesVnd?: number;
        discount_vnd?: number;
        fees_vnd?: number;
        validUntil?: string | null;
        conditionsNote?: string | null;
        valid_until?: string | null;
        conditions_note?: string | null;
      },
  arg3?: string,
  arg4?: {
    lines?: QuoteLineInput[];
    discount_vnd?: number;
    fees_vnd?: number;
    discountVnd?: number;
    feesVnd?: number;
    valid_until?: string | null;
    conditions_note?: string | null;
  },
): Promise<Outcome<QuoteRevision>> {
  let workspaceId: string;
  let targetChainId: string | undefined;
  let targetRevisionId: string | undefined;
  let patchLines: QuoteLineInput[] | undefined;
  let discountVnd: number | undefined;
  let feesVnd: number | undefined;
  let validUntil: string | null | undefined;
  let conditionsNote: string | null | undefined;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    targetChainId = arg2.chainId;
    targetRevisionId = arg2.revisionId;
    patchLines = arg2.lines;
    discountVnd = arg2.discountVnd ?? arg2.discount_vnd;
    feesVnd = arg2.feesVnd ?? arg2.fees_vnd;
    validUntil = arg2.validUntil ?? arg2.valid_until;
    conditionsNote = arg2.conditionsNote ?? arg2.conditions_note;
  } else {
    workspaceId = arg2;
    targetChainId = arg3!;
    patchLines = arg4?.lines;
    discountVnd = arg4?.discount_vnd ?? arg4?.discountVnd;
    feesVnd = arg4?.fees_vnd ?? arg4?.feesVnd;
    validUntil = arg4?.valid_until;
    conditionsNote = arg4?.conditions_note;
  }

  let latest: QuoteRevisionRow | null = null;
  if (targetRevisionId) {
    latest = await readRevision(db, workspaceId, targetRevisionId);
    if (latest) targetChainId = latest.chain_id;
  } else if (targetChainId) {
    latest = await readLatestRevision(db, workspaceId, targetChainId);
  }

  if (latest === null || !targetChainId) return refused('Không tìm thấy báo giá.', 404);

  if (latest.status === 'accepted') {
    return refused('Báo giá đã được chốt, không điều chỉnh được nữa.', 409);
  }

  const nextNumber = latest.revision_number + 1;
  const revisionId = id('qr');
  const createdAt = nowIso();

  const result = await db
    .prepare(
      `UPDATE quote_revisions
          SET status = 'superseded', updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'issued'`,
    )
    .bind(createdAt, latest.id, workspaceId)
    .run();

  if (result.meta.changes === 0) {
    return refused(
      `Bản báo giá mới nhất đang ở trạng thái "${latest.status}", không tạo bản điều chỉnh được.`,
      409,
    );
  }

  let linesJson = latest.lines_json;
  let subtotal = latest.subtotal_vnd;
  let discount = discountVnd ?? latest.discount_vnd;
  let fees = feesVnd ?? latest.fees_vnd;
  let total = totalOfRevision(subtotal, discount, fees);

  if (patchLines !== undefined && patchLines.length > 0) {
    const priced = await priceRequestLines(db, workspaceId, patchLines);
    if (priced.kind === 'refused') return priced;
    linesJson = JSON.stringify(priced.value);
    subtotal = subtotalOfLines(priced.value);
    total = totalOfRevision(subtotal, discount, fees);
  }

  await db
    .prepare(
      `INSERT INTO quote_revisions
         (id, chain_id, workspace_id, revision_number, status, lines_json,
          subtotal_vnd, discount_vnd, fees_vnd, total_vnd, valid_until,
          conditions_note, issued_at, accepted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      revisionId,
      targetChainId,
      workspaceId,
      nextNumber,
      linesJson,
      subtotal,
      discount,
      fees,
      total,
      validUntil !== undefined ? validUntil : latest.valid_until,
      conditionsNote !== undefined ? conditionsNote : latest.conditions_note,
      createdAt,
      createdAt,
    )
    .run();

  const created = await readRevision(db, workspaceId, revisionId);
  if (created === null) return refused('Không đọc lại được bản điều chỉnh vừa tạo.', 500);

  return ok(parseRevision(created));
}

export const reviseIssuedQuote = reviseIssued;

/* -------------------------------------------------------------------------- */
/* Acceptance and orders                                                       */
/* -------------------------------------------------------------------------- */

export interface CreatedOrder {
  id: string;
  order_code: string;
  quote_chain_id: string;
  accepted_revision_id: string;
  total_vnd: number;
  deposit_required_vnd: number;
  status: string;
  created_at: string;
}

export interface AcceptRevisionResult {
  order: OrderRow;
  revision: QuoteRevision;
  created: boolean;
  // Also flat properties matching OrderRow & CreatedOrder
  id: string;
  order_code: string;
  quote_chain_id: string;
  accepted_revision_id: string;
  total_vnd: number;
  deposit_required_vnd: number;
  status: string;
  created_at: string;
}

/**
 * Accepts a revision and creates its order, atomically and idempotently.
 * Supports:
 *   - acceptRevision(db, { workspaceId, revisionId, depositRateBps?, pilotCreditVnd?, note?, actorId? })
 *   - acceptRevision(db, workspaceId, revisionId, args)
 *   - alias: acceptRevisionAndCreateOrder
 */
export async function acceptRevision(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        revisionId: string;
        depositRateBps?: number;
        pilotCreditVnd?: number;
        actorId?: string;
        note?: string | null;
      },
  arg3?: string,
  arg4?: {
    depositRateBps?: number;
    pilotCreditVnd?: number;
    actorId?: string;
    note?: string | null;
  },
): Promise<Outcome<AcceptRevisionResult>> {
  let workspaceId: string;
  let revisionId: string;
  let depositRateBps = 3000;
  let pilotCreditVnd = 0;
  let actorId: string | undefined;
  let note: string | null = null;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    revisionId = arg2.revisionId;
    depositRateBps = arg2.depositRateBps ?? 3000;
    pilotCreditVnd = arg2.pilotCreditVnd ?? 0;
    actorId = arg2.actorId;
    note = arg2.note ?? null;
  } else {
    workspaceId = arg2;
    revisionId = arg3!;
    depositRateBps = arg4?.depositRateBps ?? 3000;
    pilotCreditVnd = arg4?.pilotCreditVnd ?? 0;
    actorId = arg4?.actorId;
    note = arg4?.note ?? null;
  }

  const resolvedActor = await resolveActorId(db, workspaceId, actorId);

  const revision = await readRevision(db, workspaceId, revisionId);
  if (revision === null) return refused('Không tìm thấy báo giá.', 404);

  // Check if chain already has an order
  const existingOrder = await readOrderForChain(db, workspaceId, revision.chain_id);
  if (existingOrder !== null) {
    // If the existing order is for this exact revision, idempotent success
    if (existingOrder.accepted_revision_id === revisionId) {
      return ok({
        ...existingOrder,
        order: existingOrder,
        revision: parseRevision(revision),
        created: false,
      });
    }
    // Conflicting revision in the same chain
    return refused('Bảng báo giá này đã có phiên bản được chốt trước đó.', 409);
  }

  if (revision.status !== 'issued') {
    return refused(
      `Báo giá đang ở trạng thái "${revision.status}", không chốt được.`,
      409,
    );
  }

  const acceptedAt = nowIso();
  const deposit = depositRequired(revision.total_vnd, depositRateBps);

  const accepted = await db
    .prepare(
      `UPDATE quote_revisions
          SET status = 'accepted', accepted_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'issued'`,
    )
    .bind(acceptedAt, acceptedAt, revisionId, workspaceId)
    .run();

  if (accepted.meta.changes === 0) {
    return refused('Báo giá đã đổi trạng thái, thao tác bị từ chối.', 409);
  }

  const chain = await db
    .prepare(`SELECT id, customer_id, reference FROM quote_chains WHERE id = ? AND workspace_id = ?`)
    .bind(revision.chain_id, workspaceId)
    .first<{ id: string; customer_id: string; reference: string }>();
  if (chain === null) return refused('Không tìm thấy bảng báo giá.', 404);

  const orderId = id('or');
  const orderCode = `ORD-${chain.reference}-${revision.revision_number}`;
  const status = deposit > 0 && deposit < revision.total_vnd ? 'pending_deposit' : 'processing';

  await db.batch([
    db
      .prepare(
        `INSERT INTO orders
           (id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
            order_code, total_vnd, deposit_required_vnd, pilot_credit_applied_vnd,
            collected_vnd, refund_owed_vnd, status, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .bind(
        orderId,
        workspaceId,
        revision.chain_id,
        revisionId,
        chain.customer_id,
        orderCode,
        revision.total_vnd,
        deposit,
        pilotCreditVnd,
        status,
        note,
        acceptedAt,
        acceptedAt,
      ),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, ?, 'quote.accepted', 'quote_revision', ?, ?, ?)`,
      )
      .bind(
        id('ae'),
        workspaceId,
        resolvedActor,
        revisionId,
        JSON.stringify({
          chain_id: revision.chain_id,
          revision_number: revision.revision_number,
          total_vnd: revision.total_vnd,
          order_code: orderCode,
        }),
        acceptedAt,
      ),
  ]);

  const savedOrder = await readOrder(db, workspaceId, orderId);
  const updatedRev = await readRevision(db, workspaceId, revisionId);
  if (savedOrder === null || updatedRev === null) {
    return refused('Không đọc lại được đơn hàng vừa tạo.', 500);
  }

  return ok({
    ...savedOrder,
    order: savedOrder,
    revision: parseRevision(updatedRev),
    created: true,
  });
}

export const acceptRevisionAndCreateOrder = acceptRevision;

/**
 * Moves an order through its state machine, refusing an illegal transition.
 * Supports:
 *   - transitionOrder(db, { workspaceId, orderId, to, actorId? })
 *   - transitionOrder(db, workspaceId, orderId, to, actorId?)
 *   - alias: transitionOrderStatus
 */
export async function transitionOrder(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        orderId: string;
        to: OrderStatus;
        actorId?: string;
      },
  arg3?: string,
  arg4?: OrderStatus,
  arg5?: string,
): Promise<Outcome<OrderRow>> {
  let workspaceId: string;
  let orderId: string;
  let to: OrderStatus;
  let actorId: string | undefined;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    orderId = arg2.orderId;
    to = arg2.to;
    actorId = arg2.actorId;
  } else {
    workspaceId = arg2;
    orderId = arg3!;
    to = arg4!;
    actorId = arg5;
  }

  const resolvedActor = await resolveActorId(db, workspaceId, actorId);

  const order = await readOrder(db, workspaceId, orderId);
  if (order === null) return refused('Không tìm thấy đơn hàng.', 404);

  const from = order.status as OrderStatus;
  if (from === to) return ok(order);
  if (!canTransition(from, to)) {
    return refused(`Không thể chuyển đơn từ "${from}" sang "${to}".`, 409);
  }

  const updatedAt = nowIso();
  const result = await db
    .prepare(
      `UPDATE orders SET status = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = ?`,
    )
    .bind(to, updatedAt, orderId, workspaceId, from)
    .run();

  if (result.meta.changes === 0) {
    return refused('Đơn hàng đã đổi trạng thái, thao tác bị từ chối.', 409);
  }

  await db
    .prepare(
      `INSERT INTO audit_events
         (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
       VALUES (?, ?, ?, 'order.status_changed', 'order', ?, ?, ?)`,
    )
    .bind(
      id('ae'),
      workspaceId,
      resolvedActor,
      orderId,
      JSON.stringify({ from, to }),
      updatedAt,
    )
    .run();

  const updated = await readOrder(db, workspaceId, orderId);
  if (updated === null) return refused('Không đọc lại được đơn hàng vừa cập nhật.', 500);
  return ok(updated);
}

export const transitionOrderStatus = transitionOrder;

/* -------------------------------------------------------------------------- */
/* Receipts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Records a payment in 'pending', awaiting a human confirmation.
 * Supports:
 *   - createReceipt(db, { workspaceId, orderId, amountVnd, reference?, note?, actorId? })
 *   - createReceipt(db, workspaceId, args)
 */
export async function createReceipt(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        orderId: string;
        amountVnd: number;
        reference?: string;
        note?: string | null;
        actorId?: string;
      },
  arg3?: {
    orderId: string;
    amountVnd: number;
    reference?: string;
    note?: string | null;
    actorId?: string;
  },
): Promise<Outcome<ReceiptRow>> {
  let workspaceId: string;
  let orderId: string;
  let amountVnd: number;
  let reference: string;
  let note: string | null = null;
  let actorId: string | undefined;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    orderId = arg2.orderId;
    amountVnd = arg2.amountVnd;
    reference = arg2.reference ?? `RC-${Date.now()}`;
    note = arg2.note ?? null;
    actorId = arg2.actorId;
  } else {
    workspaceId = arg2;
    orderId = arg3!.orderId;
    amountVnd = arg3!.amountVnd;
    reference = arg3!.reference ?? `RC-${Date.now()}`;
    note = arg3!.note ?? null;
    actorId = arg3!.actorId;
  }

  const resolvedActor = await resolveActorId(db, workspaceId, actorId);

  const order = await readOrder(db, workspaceId, orderId);
  if (order === null) return refused('Không tìm thấy đơn hàng.', 404);
  if (order.status === 'cancelled') {
    return refused('Đơn đã hủy, không ghi nhận thanh toán mới.', 409);
  }

  const receiptId = id('rc');
  const createdAt = nowIso();

  await db.batch([
    db
      .prepare(
        `INSERT INTO receipts
           (id, workspace_id, order_id, amount_vnd, status, reference,
            confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
            note, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .bind(
        receiptId,
        workspaceId,
        orderId,
        amountVnd,
        reference,
        note,
        createdAt,
        createdAt,
      ),
    db
      .prepare(
        `INSERT INTO receipt_events
           (id, receipt_id, kind, actor_id, amount_vnd, detail, created_at)
         VALUES (?, ?, 'create', ?, ?, ?, ?)`,
      )
      .bind(
        id('re'),
        receiptId,
        resolvedActor,
        amountVnd,
        `Ghi nhận khoản tiền chờ xác nhận, mã tham chiếu ${reference}`,
        createdAt,
      ),
  ]);

  const saved = await db
    .prepare(
      `SELECT id, workspace_id, order_id, amount_vnd, status, reference,
              confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
              note, created_at, updated_at
         FROM receipts WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, receiptId)
    .first<ReceiptRow>();
  if (saved === null) return refused('Không đọc lại được phiếu thu vừa tạo.', 500);
  return ok(saved);
}

/**
 * Confirms a pending receipt, refusing over-payment with a stated reason.
 * Supports:
 *   - confirmReceipt(db, { workspaceId, receiptId, confirmedBy?, actorId?, confirmedAt?, reference? })
 *   - confirmReceipt(db, workspaceId, args)
 */
export async function confirmReceipt(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        receiptId: string;
        confirmedBy?: string;
        actorId?: string;
        confirmedAt?: string;
        reference?: string;
      },
  arg3?: {
    receiptId: string;
    confirmedBy?: string;
    actorId?: string;
    confirmedAt?: string;
    reference?: string;
  },
): Promise<Outcome<{ receipt: ReceiptRow; order: OrderRow }>> {
  let workspaceId: string;
  let receiptId: string;
  let confirmedByCandidate: string | undefined;
  let confirmedAt: string;
  let referenceOverride: string | undefined;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    receiptId = arg2.receiptId;
    confirmedByCandidate = arg2.confirmedBy ?? arg2.actorId;
    confirmedAt = arg2.confirmedAt ?? nowIso();
    referenceOverride = arg2.reference;
  } else {
    workspaceId = arg2;
    receiptId = arg3!.receiptId;
    confirmedByCandidate = arg3!.confirmedBy ?? arg3!.actorId;
    confirmedAt = arg3!.confirmedAt ?? nowIso();
    referenceOverride = arg3!.reference;
  }

  const confirmedBy = await resolveActorId(db, workspaceId, confirmedByCandidate);

  const receipt = await db
    .prepare(
      `SELECT id, workspace_id, order_id, amount_vnd, status, reference,
              confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
              note, created_at, updated_at
         FROM receipts WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, receiptId)
    .first<ReceiptRow>();
  if (receipt === null) return refused('Không tìm thấy phiếu thu.', 404);
  if (receipt.status !== 'pending') {
    return refused(`Phiếu thu đang ở trạng thái "${receipt.status}", không xác nhận lại được.`, 409);
  }

  const order = await readOrder(db, workspaceId, receipt.order_id);
  if (order === null) return refused('Không tìm thấy đơn hàng của phiếu thu.', 404);

  const remaining = order.total_vnd - order.pilot_credit_applied_vnd - order.collected_vnd;
  if (receipt.amount_vnd > remaining) {
    return refused(
      `Khoản tiền ${formatVnd(receipt.amount_vnd)}₫ vượt quá tổng giá trị đơn hàng (còn lại ${formatVnd(remaining)}₫), không thể xác nhận.`,
      409,
    );
  }

  const finalReference = referenceOverride ?? receipt.reference;

  const confirmed = await db
    .prepare(
      `UPDATE receipts
          SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, reference = ?,
              updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    )
    .bind(
      confirmedBy,
      confirmedAt,
      finalReference,
      confirmedAt,
      receiptId,
      workspaceId,
    )
    .run();

  if (confirmed.meta.changes === 0) {
    return refused('Phiếu thu đã đổi trạng thái, thao tác bị từ chối.', 409);
  }

  const collected = order.collected_vnd + receipt.amount_vnd;
  const satisfiesDeposit =
    collected + order.pilot_credit_applied_vnd >= order.deposit_required_vnd;
  const nextStatus =
    satisfiesDeposit && order.status === 'pending_deposit' ? 'deposit_confirmed' : order.status;

  const applied = await db
    .prepare(
      `UPDATE orders
          SET collected_vnd = ?, status = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND collected_vnd = ?`,
    )
    .bind(collected, nextStatus, confirmedAt, order.id, workspaceId, order.collected_vnd)
    .run();

  if (applied.meta.changes === 0) {
    const fresh = await readOrder(db, workspaceId, order.id);
    if (fresh === null) return refused('Không tìm thấy đơn hàng.', 404);
    return refused(
      `Đơn đã có ${formatVnd(fresh.collected_vnd)}₫ được xác nhận bởi người khác, thao tác bị từ chối.`,
      409,
    );
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO receipt_events
           (id, receipt_id, kind, actor_id, amount_vnd, detail, created_at)
         VALUES (?, ?, 'confirm', ?, ?, ?, ?)`,
      )
      .bind(
        id('re'),
        receiptId,
        confirmedBy,
        receipt.amount_vnd,
        `Xác nhận đã nhận, mã tham chiếu ${finalReference}`,
        confirmedAt,
      ),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, ?, 'receipt.confirmed', 'receipt', ?, ?, ?)`,
      )
      .bind(
        id('ae'),
        workspaceId,
        confirmedBy,
        receiptId,
        JSON.stringify({ order_id: order.id, amount_vnd: receipt.amount_vnd }),
        confirmedAt,
      ),
  ]);

  const updatedReceipt = await db
    .prepare(
      `SELECT id, workspace_id, order_id, amount_vnd, status, reference,
              confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
              note, created_at, updated_at
         FROM receipts WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, receiptId)
    .first<ReceiptRow>();
  const updatedOrder = await readOrder(db, workspaceId, order.id);
  if (updatedReceipt === null || updatedOrder === null) {
    return refused('Không đọc lại được dữ liệu sau khi xác nhận.', 500);
  }
  return ok({ receipt: updatedReceipt, order: updatedOrder });
}

/**
 * Reverses a confirmed receipt, recording a reason and an audit row.
 * Supports:
 *   - reverseReceipt(db, { workspaceId, receiptId, reason, reversedBy?, actorId?, reversedAt? })
 *   - reverseReceipt(db, workspaceId, args)
 */
export async function reverseReceipt(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        receiptId: string;
        reason: string;
        reversedBy?: string;
        actorId?: string;
        reversedAt?: string;
      },
  arg3?: {
    receiptId: string;
    reason: string;
    reversedBy?: string;
    actorId?: string;
    reversedAt?: string;
  },
): Promise<Outcome<{ receipt: ReceiptRow; order: OrderRow; refundOwedVnd: number }>> {
  let workspaceId: string;
  let receiptId: string;
  let reason: string;
  let reversedByCandidate: string | undefined;
  let reversedAt: string;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    receiptId = arg2.receiptId;
    reason = arg2.reason;
    reversedByCandidate = arg2.reversedBy ?? arg2.actorId;
    reversedAt = arg2.reversedAt ?? nowIso();
  } else {
    workspaceId = arg2;
    receiptId = arg3!.receiptId;
    reason = arg3!.reason;
    reversedByCandidate = arg3!.reversedBy ?? arg3!.actorId;
    reversedAt = arg3!.reversedAt ?? nowIso();
  }

  const reversedBy = await resolveActorId(db, workspaceId, reversedByCandidate);

  const receipt = await db
    .prepare(
      `SELECT id, workspace_id, order_id, amount_vnd, status, reference,
              confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
              note, created_at, updated_at
         FROM receipts WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, receiptId)
    .first<ReceiptRow>();
  if (receipt === null) return refused('Không tìm thấy phiếu thu.', 404);
  if (receipt.status !== 'confirmed') {
    return refused(
      `Chỉ đảo phiếu thu đã xác nhận. Phiếu này đang ở trạng thái "${receipt.status}".`,
      409,
    );
  }

  const order = await readOrder(db, workspaceId, receipt.order_id);
  if (order === null) return refused('Không tìm thấy đơn hàng của phiếu thu.', 404);

  const reversed = await db
    .prepare(
      `UPDATE receipts
          SET status = 'reversed', reversal_reason = ?, reversed_by = ?, reversed_at = ?,
              updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'confirmed'`,
    )
    .bind(reason, reversedBy, reversedAt, reversedAt, receiptId, workspaceId)
    .run();

  if (reversed.meta.changes === 0) {
    return refused('Phiếu thu đã đổi trạng thái, thao tác bị từ chối.', 409);
  }

  const collected = Math.max(0, order.collected_vnd - receipt.amount_vnd);
  const refundOwed = order.status === 'cancelled' ? collected : 0;

  const applied = await db
    .prepare(
      `UPDATE orders
          SET collected_vnd = ?, refund_owed_vnd = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND collected_vnd = ?`,
    )
    .bind(collected, refundOwed, reversedAt, order.id, workspaceId, order.collected_vnd)
    .run();

  if (applied.meta.changes === 0) {
    return refused('Đơn hàng đã đổi trạng thái, thao tác bị từ chối.', 409);
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO receipt_events
           (id, receipt_id, kind, actor_id, amount_vnd, detail, created_at)
         VALUES (?, ?, 'reverse', ?, ?, ?, ?)`,
      )
      .bind(
        id('re'),
        receiptId,
        reversedBy,
        receipt.amount_vnd,
        `Đảo khoản đã nhận: ${reason}`,
        reversedAt,
      ),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, ?, 'receipt.reversed', 'receipt', ?, ?, ?)`,
      )
      .bind(
        id('ae'),
        workspaceId,
        reversedBy,
        receiptId,
        JSON.stringify({ order_id: order.id, amount_vnd: receipt.amount_vnd, reason }),
        reversedAt,
      ),
  ]);

  const updatedReceipt = await db
    .prepare(
      `SELECT id, workspace_id, order_id, amount_vnd, status, reference,
              confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
              note, created_at, updated_at
         FROM receipts WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, receiptId)
    .first<ReceiptRow>();
  const updatedOrder = await readOrder(db, workspaceId, order.id);
  if (updatedReceipt === null || updatedOrder === null) {
    return refused('Không đọc lại được dữ liệu sau khi đảo.', 500);
  }
  return ok({ receipt: updatedReceipt, order: updatedOrder, refundOwedVnd: refundOwed });
}

/* -------------------------------------------------------------------------- */
/* Deliveries                                                                  */
/* -------------------------------------------------------------------------- */

export async function readDelivery(
  db: D1Like,
  workspaceId: string,
  deliveryId: string,
): Promise<DeliveryRow | null> {
  return db
    .prepare(
      `SELECT id, workspace_id, order_id, scheduled_date, status, delivery_address,
              under_deposit_override, override_reason, override_by, assigned_to, note,
              created_at, updated_at
         FROM deliveries WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, deliveryId)
    .first<DeliveryRow>();
}

/**
 * Schedules a delivery for an order.
 * Supports:
 *   - createDelivery(db, { workspaceId, orderId, scheduledDate, deliveryAddress?, assignedTo?, note?, overrideUnderDeposit?, overrideReason?, overrideBy? })
 *   - createDelivery(db, workspaceId, args)
 */
export async function createDelivery(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        orderId: string;
        scheduledDate: string;
        deliveryAddress?: string;
        assignedTo?: string | null;
        note?: string | null;
        overrideUnderDeposit?: boolean;
        overrideReason?: string | null;
        overrideBy?: string | null;
      },
  arg3?: {
    orderId: string;
    scheduledDate: string;
    deliveryAddress?: string;
    assignedTo?: string | null;
    note?: string | null;
    overrideUnderDeposit?: boolean;
    overrideReason?: string | null;
    overrideBy?: string | null;
  },
): Promise<Outcome<{ delivery: DeliveryRow; underDeposit: boolean } & DeliveryRow>> {
  let workspaceId: string;
  let orderId: string;
  let scheduledDate: string;
  let deliveryAddress: string;
  let assignedTo: string | null = null;
  let note: string | null = null;
  let overrideUnderDeposit = false;
  let overrideReason: string | null = null;
  let overrideByCandidate: string | null = null;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    orderId = arg2.orderId;
    scheduledDate = arg2.scheduledDate;
    deliveryAddress = arg2.deliveryAddress ?? 'Giao tại vườn Sa Đéc';
    assignedTo = arg2.assignedTo ?? null;
    note = arg2.note ?? null;
    overrideUnderDeposit = arg2.overrideUnderDeposit ?? false;
    overrideReason = arg2.overrideReason ?? null;
    overrideByCandidate = arg2.overrideBy ?? null;
  } else {
    workspaceId = arg2;
    orderId = arg3!.orderId;
    scheduledDate = arg3!.scheduledDate;
    deliveryAddress = arg3!.deliveryAddress ?? 'Giao tại vườn Sa Đéc';
    assignedTo = arg3!.assignedTo ?? null;
    note = arg3!.note ?? null;
    overrideUnderDeposit = arg3!.overrideUnderDeposit ?? false;
    overrideReason = arg3!.overrideReason ?? null;
    overrideByCandidate = arg3!.overrideBy ?? null;
  }

  const order = await readOrder(db, workspaceId, orderId);
  if (order === null) return refused('Không tìm thấy đơn hàng.', 404);

  const existing = await db
    .prepare(`SELECT id FROM deliveries WHERE workspace_id = ? AND order_id = ?`)
    .bind(workspaceId, orderId)
    .first<{ id: string }>();
  if (existing !== null) {
    return refused('Đơn này đã có lịch giao.', 409);
  }

  const underDeposit =
    order.collected_vnd + order.pilot_credit_applied_vnd < order.deposit_required_vnd;

  if (underDeposit && !overrideUnderDeposit) {
    return refused('Đơn hàng chưa thu đủ cọc quy định, không thể tạo lịch giao.', 409);
  }

  let overrideBy: string | null = null;
  if (overrideUnderDeposit) {
    overrideBy = await resolveActorId(db, workspaceId, overrideByCandidate ?? undefined);
  }

  const deliveryId = id('dl');
  const createdAt = nowIso();

  await db.batch([
    db
      .prepare(
        `INSERT INTO deliveries
           (id, workspace_id, order_id, scheduled_date, status, delivery_address,
            under_deposit_override, override_reason, override_by, assigned_to, note,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deliveryId,
        workspaceId,
        orderId,
        scheduledDate,
        deliveryAddress,
        overrideUnderDeposit ? 1 : 0,
        overrideReason,
        overrideBy,
        assignedTo,
        note,
        createdAt,
        createdAt,
      ),
    db
      .prepare(
        `INSERT INTO audit_events
           (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, ?, 'delivery.scheduled', 'delivery', ?, ?, ?)`,
      )
      .bind(
        id('ae'),
        workspaceId,
        overrideBy ?? (await resolveActorId(db, workspaceId, undefined)),
        deliveryId,
        JSON.stringify({ order_id: orderId, scheduled_date: scheduledDate }),
        createdAt,
      ),
  ]);

  const saved = await readDelivery(db, workspaceId, deliveryId);
  if (saved === null) return refused('Không đọc lại được lịch giao vừa tạo.', 500);
  return ok({ ...saved, delivery: saved, underDeposit });
}

/**
 * Records the owner's exception for delivering before the deposit is complete.
 * Supports:
 *   - overrideUnderDepositDelivery(db, { workspaceId, deliveryId?, orderId?, reason, overrideBy?, actorId?, scheduledDate?, deliveryAddress?, assignedTo?, note? })
 *   - overrideUnderDepositDelivery(db, workspaceId, args)
 */
export async function overrideUnderDepositDelivery(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        deliveryId?: string;
        orderId?: string;
        reason: string;
        overrideBy?: string;
        actorId?: string;
        scheduledDate?: string;
        deliveryAddress?: string;
        assignedTo?: string | null;
        note?: string | null;
        at?: string;
      },
  arg3?: {
    deliveryId?: string;
    orderId?: string;
    reason: string;
    overrideBy?: string;
    actorId?: string;
    scheduledDate?: string;
    deliveryAddress?: string;
    assignedTo?: string | null;
    note?: string | null;
    at?: string;
  },
): Promise<Outcome<DeliveryRow>> {
  let workspaceId: string;
  let deliveryId: string | undefined;
  let orderId: string | undefined;
  let reason: string;
  let overrideByCandidate: string | undefined;
  let at: string;
  let scheduledDate: string | undefined;
  let deliveryAddress: string | undefined;
  let assignedTo: string | null | undefined;
  let note: string | null | undefined;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    deliveryId = arg2.deliveryId;
    orderId = arg2.orderId;
    reason = arg2.reason;
    overrideByCandidate = arg2.overrideBy ?? arg2.actorId;
    at = arg2.at ?? nowIso();
    scheduledDate = arg2.scheduledDate;
    deliveryAddress = arg2.deliveryAddress;
    assignedTo = arg2.assignedTo;
    note = arg2.note;
  } else {
    workspaceId = arg2;
    deliveryId = arg3!.deliveryId;
    orderId = arg3!.orderId;
    reason = arg3!.reason;
    overrideByCandidate = arg3!.overrideBy ?? arg3!.actorId;
    at = arg3!.at ?? nowIso();
    scheduledDate = arg3!.scheduledDate;
    deliveryAddress = arg3!.deliveryAddress;
    assignedTo = arg3!.assignedTo;
    note = arg3!.note;
  }

  const overrideBy = await resolveActorId(db, workspaceId, overrideByCandidate);

  // If orderId is provided without existing delivery, create scheduled delivery with override
  if (!deliveryId && orderId) {
    const existing = await db
      .prepare(`SELECT id FROM deliveries WHERE workspace_id = ? AND order_id = ?`)
      .bind(workspaceId, orderId)
      .first<{ id: string }>();
    if (existing) {
      deliveryId = existing.id;
    } else {
      const createdRes = await createDelivery(db, {
        workspaceId,
        orderId,
        scheduledDate: scheduledDate ?? nowIso().slice(0, 10),
        deliveryAddress: deliveryAddress ?? 'Giao tại vườn',
        assignedTo: assignedTo ?? null,
        note: note ?? null,
        overrideUnderDeposit: true,
        overrideReason: reason,
        overrideBy,
      });
      if (createdRes.kind === 'refused') return createdRes;
      return ok(createdRes.value.delivery);
    }
  }

  if (!deliveryId) return refused('Thiếu thông tin lịch giao hoặc đơn hàng.', 400);

  const delivery = await readDelivery(db, workspaceId, deliveryId);
  if (delivery === null) return refused('Không tìm thấy lịch giao.', 404);

  const result = await db
    .prepare(
      `UPDATE deliveries
          SET under_deposit_override = 1, override_reason = ?, override_by = ?,
              assigned_to = COALESCE(?, assigned_to), updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'scheduled'`,
    )
    .bind(reason, overrideBy, assignedTo ?? null, at, deliveryId, workspaceId)
    .run();

  if (result.meta.changes === 0) {
    return refused('Lịch giao đã đổi trạng thái, không ghi nhận ngoại lệ được.', 409);
  }

  await db
    .prepare(
      `INSERT INTO audit_events
         (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
       VALUES (?, ?, ?, 'delivery.under_deposit_override', 'delivery', ?, ?, ?)`,
    )
    .bind(
      id('ae'),
      workspaceId,
      overrideBy,
      deliveryId,
      JSON.stringify({ order_id: delivery.order_id, reason }),
      at,
    )
    .run();

  const updated = await readDelivery(db, workspaceId, deliveryId);
  if (updated === null) return refused('Không đọc lại được lịch giao vừa cập nhật.', 500);
  return ok(updated);
}

/**
 * Transitions delivery status (scheduled -> in_transit -> delivered).
 */
export async function updateDeliveryStatus(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        deliveryId: string;
        status: DeliveryStatus | string;
        actorId?: string;
      },
  arg3?: {
    deliveryId: string;
    status: DeliveryStatus | string;
    actorId?: string;
  },
): Promise<Outcome<DeliveryRow>> {
  let workspaceId: string;
  let deliveryId: string;
  let status: string;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    deliveryId = arg2.deliveryId;
    status = arg2.status;
  } else {
    workspaceId = arg2;
    deliveryId = arg3!.deliveryId;
    status = arg3!.status;
  }

  const delivery = await readDelivery(db, workspaceId, deliveryId);
  if (delivery === null) return refused('Không tìm thấy lịch giao.', 404);

  const order = await readOrder(db, workspaceId, delivery.order_id);
  if (order === null) return refused('Không tìm thấy đơn hàng của lịch giao.', 404);

  const depositCovered =
    order.collected_vnd + order.pilot_credit_applied_vnd >= order.deposit_required_vnd;
  const overrideAllowed =
    delivery.under_deposit_override === 1 &&
    delivery.override_reason !== null &&
    delivery.override_reason.trim() !== '';

  if (
    (status === 'in_transit' || status === 'delivered') &&
    !depositCovered &&
    !overrideAllowed
  ) {
    return refused(
      'Đơn chưa thu đủ tiền cọc và chưa có ngoại lệ được chủ vườn duyệt kèm lý do.',
      409,
    );
  }

  const updatedAt = nowIso();
  const result = await db
    .prepare(
      `UPDATE deliveries SET status = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    )
    .bind(status, updatedAt, deliveryId, workspaceId)
    .run();

  if (result.meta.changes === 0) {
    return refused('Không cập nhật được lịch giao.', 409);
  }

  if (status === 'delivered' && order.status !== 'delivered') {
    await db
      .prepare(
        `UPDATE orders SET status = 'delivered', updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      )
      .bind(updatedAt, order.id, workspaceId)
      .run();
  }

  const updated = await readDelivery(db, workspaceId, deliveryId);
  if (updated === null) return refused('Không đọc lại được lịch giao vừa cập nhật.', 500);
  return ok(updated);
}

/* -------------------------------------------------------------------------- */
/* Follow-up tasks                                                             */
/* -------------------------------------------------------------------------- */

export async function createFollowUpTask(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        orderId?: string | null;
        customerId: string;
        dueDate: string;
        taskKind: string;
        assignedTo?: string | null;
        note?: string | null;
      },
  arg3?: {
    orderId?: string | null;
    customerId: string;
    dueDate: string;
    taskKind: string;
    assignedTo?: string | null;
    note?: string | null;
  },
): Promise<Outcome<FollowUpTaskRow>> {
  let workspaceId: string;
  let orderId: string | null = null;
  let customerId: string;
  let dueDate: string;
  let taskKind: string;
  let assignedTo: string | null = null;
  let note: string | null = null;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    orderId = arg2.orderId ?? null;
    customerId = arg2.customerId;
    dueDate = arg2.dueDate;
    taskKind = arg2.taskKind;
    assignedTo = arg2.assignedTo ?? null;
    note = arg2.note ?? null;
  } else {
    workspaceId = arg2;
    orderId = arg3!.orderId ?? null;
    customerId = arg3!.customerId;
    dueDate = arg3!.dueDate;
    taskKind = arg3!.taskKind;
    assignedTo = arg3!.assignedTo ?? null;
    note = arg3!.note ?? null;
  }

  const customer = await db
    .prepare(`SELECT id FROM customers WHERE workspace_id = ? AND id = ?`)
    .bind(workspaceId, customerId)
    .first<{ id: string }>();
  if (customer === null) return refused('Khách không thuộc workspace này.', 400);

  if (orderId !== null) {
    const order = await db
      .prepare(`SELECT id FROM orders WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, orderId)
      .first<{ id: string }>();
    if (order === null) return refused('Đơn hàng không thuộc workspace này.', 400);
  }

  const taskId = id('ft');
  const createdAt = nowIso();

  await db
    .prepare(
      `INSERT INTO follow_up_tasks
         (id, workspace_id, order_id, customer_id, due_date, task_kind, status,
          assigned_to, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    )
    .bind(
      taskId,
      workspaceId,
      orderId,
      customerId,
      dueDate,
      taskKind,
      assignedTo,
      note,
      createdAt,
      createdAt,
    )
    .run();

  const saved = await readFollowUpTask(db, workspaceId, taskId);
  if (saved === null) return refused('Không đọc lại được việc cần làm vừa tạo.', 500);
  return ok(saved);
}

export async function readFollowUpTask(
  db: D1Like,
  workspaceId: string,
  taskId: string,
): Promise<FollowUpTaskRow | null> {
  return db
    .prepare(
      `SELECT id, workspace_id, order_id, customer_id, due_date, task_kind, status,
              assigned_to, note, created_at, updated_at
         FROM follow_up_tasks WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, taskId)
    .first<FollowUpTaskRow>();
}

export async function updateFollowUpTask(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        taskId: string;
        status?: string;
        dueDate?: string;
        assignedTo?: string | null;
        note?: string | null;
      },
  arg3?: string,
  arg4?: {
    status?: string;
    dueDate?: string;
    assignedTo?: string | null;
    note?: string | null;
  },
): Promise<Outcome<FollowUpTaskRow>> {
  let workspaceId: string;
  let taskId: string;
  let patch: typeof arg4;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    taskId = arg2.taskId;
    patch = arg2;
  } else {
    workspaceId = arg2;
    taskId = arg3!;
    patch = arg4;
  }

  const existing = await readFollowUpTask(db, workspaceId, taskId);
  if (existing === null) return refused('Không tìm thấy việc cần làm.', 404);
  if (existing.status !== 'open') {
    return refused(`Việc này đang ở trạng thái "${existing.status}", không sửa được nữa.`, 409);
  }

  const updatedAt = nowIso();
  const result = await db
    .prepare(
      `UPDATE follow_up_tasks
          SET status = ?, due_date = ?, assigned_to = ?, note = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'open'`,
    )
    .bind(
      patch?.status ?? existing.status,
      patch?.dueDate ?? existing.due_date,
      patch?.assignedTo === undefined ? existing.assigned_to : patch.assignedTo,
      patch?.note === undefined ? existing.note : patch.note,
      updatedAt,
      taskId,
      workspaceId,
    )
    .run();

  if (result.meta.changes === 0) {
    return refused('Việc cần làm đã đổi trạng thái, thao tác bị từ chối.', 409);
  }

  const updated = await readFollowUpTask(db, workspaceId, taskId);
  if (updated === null) return refused('Không đọc lại được việc cần làm vừa cập nhật.', 500);
  return ok(updated);
}

/* -------------------------------------------------------------------------- */
/* Cancellation and refunds                                                    */
/* -------------------------------------------------------------------------- */

export async function cancelOrder(
  db: D1Like,
  arg2:
    | string
    | {
        workspaceId: string;
        orderId: string;
        reason: string;
        actorId?: string;
      },
  arg3?: { orderId: string; reason: string; actorId?: string },
): Promise<Outcome<OrderRow>> {
  let workspaceId: string;
  let orderId: string;
  let reason: string;
  let actorId: string | undefined;

  if (typeof arg2 === 'object') {
    workspaceId = arg2.workspaceId;
    orderId = arg2.orderId;
    reason = arg2.reason;
    actorId = arg2.actorId;
  } else {
    workspaceId = arg2;
    orderId = arg3!.orderId;
    reason = arg3!.reason;
    actorId = arg3!.actorId;
  }

  const resolvedActor = await resolveActorId(db, workspaceId, actorId);

  const order = await readOrder(db, workspaceId, orderId);
  if (order === null) return refused('Không tìm thấy đơn hàng.', 404);
  if (order.status === 'delivered') {
    return refused('Đơn đã giao xong, không hủy được.', 409);
  }
  if (order.status === 'cancelled') return ok(order);

  const cancelledAt = nowIso();
  const result = await db
    .prepare(
      `UPDATE orders
          SET status = 'cancelled', refund_owed_vnd = ?, note = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status != 'cancelled'`,
    )
    .bind(order.collected_vnd, order.note, cancelledAt, orderId, workspaceId)
    .run();

  if (result.meta.changes === 0) {
    return refused('Đơn hàng đã đổi trạng thái, thao tác bị từ chối.', 409);
  }

  await db
    .prepare(
      `INSERT INTO audit_events
         (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
       VALUES (?, ?, ?, 'order.cancelled', 'order', ?, ?, ?)`,
    )
    .bind(
      id('ae'),
      workspaceId,
      resolvedActor,
      orderId,
      JSON.stringify({ reason, refund_owed_vnd: order.collected_vnd }),
      cancelledAt,
    )
    .run();

  const updated = await readOrder(db, workspaceId, orderId);
  if (updated === null) return refused('Không đọc lại được đơn hàng vừa hủy.', 500);
  return ok(updated);
}

/* -------------------------------------------------------------------------- */
/* Today summary and workspace list views                                      */
/* -------------------------------------------------------------------------- */

export interface TodaySummary {
  // Classic snake_case keys
  quotes_to_prepare: number;
  contacts_to_follow_up: number;
  deposits_to_confirm: number;
  deliveries_to_schedule: number;
  refund_obligations_vnd: number;
  refund_orders: number;
  // Modern Part A / test keys
  todayDate: string;
  draftQuotesCount: number;
  awaitingDepositOrders: OrderRow[];
  deliveriesToday: DeliveryRow[];
  openTasks: FollowUpTaskRow[];
}

/**
 * Computes the Today page summary from live database tables.
 */
export async function readTodaySummary(
  db: D1Like,
  workspaceId: string,
  today: string = nowIso().slice(0, 10),
): Promise<TodaySummary> {
  const quotes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM quote_revisions
        WHERE workspace_id = ? AND status IN ('draft', 'issued')`,
    )
    .bind(workspaceId)
    .first<{ n: number }>();

  const draftQuotes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM quote_revisions
        WHERE workspace_id = ? AND status = 'draft'`,
    )
    .bind(workspaceId)
    .first<{ n: number }>();

  const contacts = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM follow_up_tasks
        WHERE workspace_id = ? AND status = 'open' AND due_date <= ?`,
    )
    .bind(workspaceId, today)
    .first<{ n: number }>();

  const deposits = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM receipts
        WHERE workspace_id = ? AND status = 'pending'`,
    )
    .bind(workspaceId)
    .first<{ n: number }>();

  const deliveries = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM deliveries
        WHERE workspace_id = ? AND status = 'scheduled'`,
    )
    .bind(workspaceId)
    .first<{ n: number }>();

  const refunds = await db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(refund_owed_vnd), 0) AS owed_vnd
         FROM orders
        WHERE workspace_id = ? AND refund_owed_vnd > 0`,
    )
    .bind(workspaceId)
    .first<{ orders: number; owed_vnd: number }>();

  const { results: awaitingDepositOrders } = await db
    .prepare(
      `SELECT id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
              order_code, total_vnd, deposit_required_vnd, pilot_credit_applied_vnd,
              collected_vnd, refund_owed_vnd, status, note, created_at, updated_at
         FROM orders
        WHERE workspace_id = ? AND status = 'pending_deposit'
        ORDER BY created_at DESC`,
    )
    .bind(workspaceId)
    .all<OrderRow>();

  const { results: deliveriesToday } = await db
    .prepare(
      `SELECT id, workspace_id, order_id, scheduled_date, status, delivery_address,
              under_deposit_override, override_reason, override_by, assigned_to, note,
              created_at, updated_at
         FROM deliveries
        WHERE workspace_id = ? AND scheduled_date = ?`,
    )
    .bind(workspaceId, today)
    .all<DeliveryRow>();

  const { results: openTasks } = await db
    .prepare(
      `SELECT id, workspace_id, order_id, customer_id, due_date, task_kind, status,
              assigned_to, note, created_at, updated_at
         FROM follow_up_tasks
        WHERE workspace_id = ? AND status = 'open'
        ORDER BY due_date ASC`,
    )
    .bind(workspaceId)
    .all<FollowUpTaskRow>();

  return {
    quotes_to_prepare: quotes?.n ?? 0,
    contacts_to_follow_up: contacts?.n ?? 0,
    deposits_to_confirm: deposits?.n ?? 0,
    deliveries_to_schedule: deliveries?.n ?? 0,
    refund_obligations_vnd: refunds?.owed_vnd ?? 0,
    refund_orders: refunds?.orders ?? 0,
    todayDate: today,
    draftQuotesCount: draftQuotes?.n ?? (quotes?.n ?? 0),
    awaitingDepositOrders,
    deliveriesToday,
    openTasks,
  };
}

export const getTodaySummary = readTodaySummary;

export async function listQuoteChains(
  db: D1Like,
  workspaceId: string,
): Promise<QuoteChainView[]> {
  const { results: chains } = await db
    .prepare(
      `SELECT qc.id, qc.workspace_id, qc.customer_id, qc.reference, qc.created_at, qc.updated_at,
              c.name AS customer_name
         FROM quote_chains qc
         LEFT JOIN customers c ON c.id = qc.customer_id AND c.workspace_id = qc.workspace_id
        WHERE qc.workspace_id = ?
        ORDER BY qc.updated_at DESC`,
    )
    .bind(workspaceId)
    .all<QuoteChainRow & { customer_name: string | null }>();

  const { results: revisions } = await db
    .prepare(
      `SELECT ${REVISION_COLUMNS}
         FROM quote_revisions
        WHERE workspace_id = ?
        ORDER BY revision_number DESC`,
    )
    .bind(workspaceId)
    .all<QuoteRevisionRow>();

  return chains.map((chain) => ({
    ...chain,
    revisions: revisions
      .filter((r) => r.chain_id === chain.id)
      .map(parseRevision),
  }));
}

export async function listOrders(db: D1Like, workspaceId: string): Promise<OrderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
              order_code, total_vnd, deposit_required_vnd, pilot_credit_applied_vnd,
              collected_vnd, refund_owed_vnd, status, note, created_at, updated_at
         FROM orders
        WHERE workspace_id = ?
        ORDER BY created_at DESC`,
    )
    .bind(workspaceId)
    .all<OrderRow>();
  return results;
}

export async function listReceipts(
  db: D1Like,
  workspaceId: string,
  orderId?: string,
): Promise<ReceiptRow[]> {
  if (orderId) {
    const { results } = await db
      .prepare(
        `SELECT id, workspace_id, order_id, amount_vnd, status, reference,
                confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
                note, created_at, updated_at
           FROM receipts
          WHERE workspace_id = ? AND order_id = ?
          ORDER BY created_at DESC`,
      )
      .bind(workspaceId, orderId)
      .all<ReceiptRow>();
    return results;
  }

  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, order_id, amount_vnd, status, reference,
              confirmed_by, confirmed_at, reversal_reason, reversed_by, reversed_at,
              note, created_at, updated_at
         FROM receipts
        WHERE workspace_id = ?
        ORDER BY created_at DESC`,
    )
    .bind(workspaceId)
    .all<ReceiptRow>();
  return results;
}

export async function listDeliveries(db: D1Like, workspaceId: string): Promise<DeliveryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, order_id, scheduled_date, status, delivery_address,
              under_deposit_override, override_reason, override_by, assigned_to, note,
              created_at, updated_at
         FROM deliveries
        WHERE workspace_id = ?
        ORDER BY scheduled_date ASC`,
    )
    .bind(workspaceId)
    .all<DeliveryRow>();
  return results;
}

export async function listFollowUpTasks(
  db: D1Like,
  workspaceId: string,
  status?: string,
): Promise<FollowUpTaskRow[]> {
  if (status) {
    const { results } = await db
      .prepare(
        `SELECT id, workspace_id, order_id, customer_id, due_date, task_kind, status,
                assigned_to, note, created_at, updated_at
           FROM follow_up_tasks
          WHERE workspace_id = ? AND status = ?
          ORDER BY due_date ASC`,
      )
      .bind(workspaceId, status)
      .all<FollowUpTaskRow>();
    return results;
  }

  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, order_id, customer_id, due_date, task_kind, status,
              assigned_to, note, created_at, updated_at
         FROM follow_up_tasks
        WHERE workspace_id = ?
        ORDER BY due_date ASC`,
    )
    .bind(workspaceId)
    .all<FollowUpTaskRow>();
  return results;
}

/* -------------------------------------------------------------------------- */
/* Printable Quote HTML                                                        */
/* -------------------------------------------------------------------------- */

export async function getPrintableQuoteHtml(
  db: D1Like,
  args: {
    workspaceId: string;
    revisionId: string;
    demo?: boolean;
    demoLabel?: string;
  },
): Promise<Outcome<string>> {
  const revision = await readRevision(db, args.workspaceId, args.revisionId);
  if (revision === null) return refused('Không tìm thấy báo giá.', 404);

  const chain = await db
    .prepare(
      `SELECT qc.reference, qc.created_at, c.name AS customer_name, c.contact_name, c.phone, c.address
         FROM quote_chains qc
         LEFT JOIN customers c ON c.id = qc.customer_id AND c.workspace_id = qc.workspace_id
        WHERE qc.id = ? AND qc.workspace_id = ?`,
    )
    .bind(revision.chain_id, args.workspaceId)
    .first<{
      reference: string;
      created_at: string;
      customer_name: string | null;
      contact_name: string | null;
      phone: string | null;
      address: string | null;
    }>();

  const parsedRev = parseRevision(revision);
  const demoBannerHtml = args.demo
    ? `<div style="background: #fef3c7; color: #92400e; padding: 12px; text-align: center; font-weight: bold; margin-bottom: 20px; border: 1px solid #f59e0b; border-radius: 4px;">${args.demoLabel ?? 'DEMO — DỮ LIệU THỨ NGHIỆM'}</div>`
    : '';

  const linesHtml = parsedRev.lines
    .map(
      (line, idx) => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${idx + 1}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${line.product_name}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: center;">${line.quantity} ${line.unit}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatVnd(line.unit_price_vnd)}₫</td>
          <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatVnd(line.line_total_vnd)}₫</td>
        </tr>
      `,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>Báo giá ${chain?.reference ?? ''} - Phiên bản v${parsedRev.revision_number}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; color: #111827; padding: 40px; max-width: 800px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 4px; text-transform: uppercase; color: #047857; }
    .disclaimer { font-size: 13px; font-weight: bold; color: #dc2626; margin-bottom: 24px; }
    .meta-table { width: 100%; margin-bottom: 24px; }
    .meta-table td { padding: 4px 0; }
    .lines-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .lines-table th { background: #f3f4f6; padding: 10px 8px; text-align: left; font-size: 13px; border-bottom: 2px solid #d1d5db; }
    .totals-area { float: right; width: 300px; margin-bottom: 24px; }
    .totals-row { display: flex; justify-content: space-between; padding: 6px 0; }
    .grand-total { font-size: 18px; font-weight: bold; color: #047857; border-top: 2px solid #d1d5db; margin-top: 8px; padding-top: 8px; }
    .footer { clear: both; margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  ${demoBannerHtml}
  <h1>BÁO GIÁ HOA KIỂNG SA ĐÉC</h1>
  <div class="disclaimer">BÁO GIÁ — KHÔNG PHẢI HÓA ĐƠN THUẾ</div>

  <table class="meta-table">
    <tr>
      <td><strong>Mã báo giá:</strong> ${chain?.reference ?? ''}</td>
      <td><strong>Phiên bản:</strong> Phiên bản v${parsedRev.revision_number}</td>
    </tr>
    <tr>
      <td><strong>Khách hàng:</strong> ${chain?.customer_name ?? 'Khách lẻ'}</td>
      <td><strong>Ngày lập:</strong> ${(parsedRev.issued_at ?? parsedRev.created_at).slice(0, 10)}</td>
    </tr>
    <tr>
      <td><strong>Liên hệ:</strong> ${chain?.contact_name ?? ''} ${chain?.phone ? '(' + chain.phone + ')' : ''}</td>
      <td><strong>Hiệu lực đến:</strong> ${parsedRev.valid_until ?? 'Trong vòng 7 ngày'}</td>
    </tr>
  </table>

  <table class="lines-table">
    <thead>
      <tr>
        <th style="width: 40px; text-align: center;">STT</th>
        <th>Mặt hàng</th>
        <th style="text-align: center;">Số lượng</th>
        <th style="text-align: right;">Đơn giá</th>
        <th style="text-align: right;">Thành tiền</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml}
    </tbody>
  </table>

  <div class="totals-area">
    <div class="totals-row">
      <span>Tổng tiền hàng:</span>
      <span>${formatVnd(parsedRev.subtotal_vnd)}₫</span>
    </div>
    ${
      parsedRev.discount_vnd > 0
        ? `<div class="totals-row">
             <span>Giảm giá:</span>
             <span>-${formatVnd(parsedRev.discount_vnd)}₫</span>
           </div>`
        : ''
    }
    ${
      parsedRev.fees_vnd > 0
        ? `<div class="totals-row">
             <span>Phí vận chuyển / phụ thu:</span>
             <span>+${formatVnd(parsedRev.fees_vnd)}₫</span>
           </div>`
        : ''
    }
    <div class="totals-row grand-total">
      <span>TỔNG CỘNG:</span>
      <span>${formatVnd(parsedRev.total_vnd)}₫</span>
    </div>
  </div>

  <div class="footer">
    <p><strong>Điều khoản:</strong> ${parsedRev.conditions_note ?? 'Thanh toán đặt cọc theo thỏa thuận trước khi xuất vườn.'}</p>
    <p>Lềng Hoa Sa Đéc, Đồng Tháp — Nền tảng B2B Kết nối Trực tiếp Vườn & Thương Lái</p>
  </div>
</body>
</html>`;

  return ok(html);
}
