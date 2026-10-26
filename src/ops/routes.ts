/**
 * The ops area's routes: products, customers and quote drafts.
 *
 * Each route is declared here with the action its permission check names, so the
 * registry in the Worker entry stays a list of paths and the authorisation
 * vocabulary stays close to the operation it describes. Nothing here reads an
 * identity from the request — the Worker resolves it and passes down only the
 * authorisation it resolved.
 *
 * §12's rules that apply to input live in these schemas: a value is either
 * parsed or the request is refused, and an ambiguous value is refused rather than
 * guessed. Money arriving as a string is refused, not coerced, because a client
 * that sends "2500000" is a client that cannot be assumed to send "25000.00".
 */

import { z } from 'zod';
import {
  findIdentity,
  listCustomers,
  listProducts,
  listQuoteDrafts,
  saveQuoteDraft,
  type CustomerRow,
  type D1Like,
  type PricedQuoteLine,
  type ProductRow,
  type QuoteDraftRow,
  type QuoteLineDraft,
  type SessionView,
} from './catalog.ts';
import type { Role } from '../security/authorize.ts';
import { DEMO_IDENTITY_LABEL } from '../security/dev-identity.ts';
import {
  DELIVERY_STATUSES,
  FOLLOW_UP_KINDS,
  ORDER_STATUSES,
  TASK_STATUSES,
  type DeliveryStatus,
  type FollowUpKind,
  type OrderStatus,
  type TaskStatus,
} from './quote-revisions.ts';
import {
  acceptRevision,
  cancelOrder,
  confirmReceipt,
  createChainWithDraft,
  createDelivery,
  createFollowUpTask,
  createReceipt,
  getPrintableQuoteHtml,
  issueRevision,
  listDeliveries,
  listFollowUpTasks,
  listOrders,
  listQuoteChains,
  listReceipts,
  overrideUnderDepositDelivery,
  readRevision,
  readTodaySummary,
  reverseReceipt,
  reviseIssued,
  saveDraftRevision,
  transitionOrder,
  updateDeliveryStatus,
  updateFollowUpTask,
} from './transactions.ts';

/** Money as an integer number of dong, with no separators and no decimal. */
const vndAmount = z.number().int().nonnegative();

export const productSchema = z.object({
  name: z.string().trim().min(1).max(200),
  species: z.string().trim().max(120).nullish(),
  size_class: z.string().trim().max(40).nullish(),
  grade: z.string().trim().max(40).nullish(),
  price_vnd: vndAmount,
  unit: z.string().trim().min(1).max(40),
  stock_note: z.string().trim().max(400).nullish(),
});

export const customerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contact_name: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
  address: z.string().trim().max(400).nullish(),
  note: z.string().trim().max(2000).nullish(),
});

export const quoteLineSchema = z.object({
  product_id: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive().max(100000),
  note: z.string().trim().max(400).nullish(),
});

export const quoteDraftSchema = z.object({
  customer_id: z.string().trim().min(1).max(64),
  reference: z.string().trim().min(1).max(80),
  lines: z.array(quoteLineSchema).min(1).max(100),
  note: z.string().trim().max(2000).nullish(),
});

export type ProductInput = z.infer<typeof productSchema>;
export type CustomerInput = z.infer<typeof customerSchema>;
export type QuoteDraftInput = z.infer<typeof quoteDraftSchema>;

/** What every ops route receives: a workspace the authorisation confirmed. */
export interface OpsRequest {
  workspaceId: string;
  db: D1Like;
}

/** The error envelope, one shape for every refusal. */
export function apiError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Turns a Zod failure into a message naming the field.
 *
 * §5 asks for an error that says which field needs fixing rather than "invalid
 * input", so the first issue's path is included. The path is the schema's, not
 * the client's, which is why it is safe to echo.
 */
function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'Dữ liệu không hợp lệ.';
  const field = issue.path.join('.');
  return field === ''
    ? `Dữ liệu không hợp lệ: ${issue.message}`
    : `Dữ liệu không hợp lệ ở "${field}": ${issue.message}`;
}

export async function handleListProducts(
  { workspaceId, db }: OpsRequest,
): Promise<Response> {
  const products = await listProducts(db, workspaceId);
  return json({ products: products.map(presentProduct) });
}

export interface SessionRequest {
  db: D1Like;
  /** The authorization the chokepoint already resolved, for display only. */
  role: Role;
  workspaceId: string;
  identity: { accessSubject: string; email: string | null; demo: boolean };
}

/**
 * Answers "who am I acting as", from the membership the chokepoint resolved.
 *
 * The role travels because §5 requires an operator to see which identity they
 * are acting as, and a person who believes they are testing as the owner while
 * acting as an operator has tested the wrong thing. It is passed in from the
 * authorization rather than read again here, so there is one answer to the role
 * question in a request, not two that can disagree.
 *
 * The workspace id travels for the same reason: it is the one the chokepoint
 * confirmed this caller holds a membership in. The UI uses it to scope the
 * requests that follow, so nothing downstream has to guess.
 */
export async function handleSession({
  db,
  role,
  workspaceId,
  identity,
}: SessionRequest): Promise<Response> {
  const row = await findIdentity(db, workspaceId, identity.accessSubject);

  const session: SessionView = {
    accessSubject: identity.accessSubject,
    email: row?.email ?? identity.email,
    displayName: row?.display_name ?? null,
    role,
    workspaceId,
    demo: identity.demo,
    // The demo identity is invented by the adapter rather than granted in the
    // seed, so its label comes from the adapter. A local session therefore shows
    // what it is instead of a blank name.
    demoLabel: identity.demo ? DEMO_IDENTITY_LABEL : null,
  };

  return json({ session });
}

export async function handleListCustomers(
  { workspaceId, db }: OpsRequest,
): Promise<Response> {
  const customers = await listCustomers(db, workspaceId);
  return json({ customers });
}

export async function handleListQuoteDrafts(
  { workspaceId, db }: OpsRequest,
): Promise<Response> {
  const drafts = await listQuoteDrafts(db, workspaceId);
  return json({
    drafts: drafts.map((draft) => ({
      ...draft,
      lines: JSON.parse(draft.lines_json) as PricedQuoteLine[],
    })),
  });
}

export async function handleSaveQuoteDraft(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = quoteDraftSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400);
  }

  const input: QuoteDraftInput = parsed.data;
  const lines: QuoteLineDraft[] = input.lines.map((line) => ({
    product_id: line.product_id,
    quantity: line.quantity,
    note: line.note ?? null,
  }));

  const saved = await saveQuoteDraft(db, {
    workspaceId,
    customerId: input.customer_id,
    reference: input.reference,
    lines,
    note: input.note ?? null,
  });

  if (saved === null) {
    // Either the customer is not in this workspace, or a line names a product
    // that is unknown or inactive. Both are refusals rather than partial saves,
    // so the message says what to check without saying which happened.
    return apiError(
      'Không lưu được báo giá: khách hoặc mặt hàng không thuộc workspace này.',
      400,
    );
  }

  return json(
    {
      draft: {
        id: saved.draft.id,
        reference: saved.draft.reference,
        customer_id: saved.draft.customer_id,
        status: saved.draft.status,
        subtotal_vnd: saved.subtotal,
        lines: saved.lines,
        note: saved.draft.note,
        updated_at: saved.draft.updated_at,
      },
    },
    201,
  );
}

function presentProduct(row: ProductRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    size_class: row.size_class,
    grade: row.grade,
    price_vnd: row.price_vnd,
    unit: row.unit,
    stock_note: row.stock_note,
  };
}

/* -------------------------------------------------------------------------- */
/* Phase 2 — Products, Customers, Quote Revisions, Orders, Receipts,          */
/*           Deliveries & Follow-up Tasks                                     */
/* -------------------------------------------------------------------------- */

export interface OpsActorRequest extends OpsRequest {
  actorId: string;
  role: Role;
  demo?: boolean;
}

const revisionLineInputSchema = z.object({
  product_id: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive().max(100000),
  discount_vnd: vndAmount.optional(),
  note: z.string().trim().max(400).nullish(),
});

const createChainSchema = z.object({
  customer_id: z.string().trim().min(1).max(64),
  reference: z.string().trim().min(1).max(80),
  lines: z.array(revisionLineInputSchema).min(1).max(100),
  discount_vnd: vndAmount.optional(),
  fees_vnd: vndAmount.optional(),
  valid_until: z.string().trim().max(40).nullish(),
  conditions_note: z.string().trim().max(2000).nullish(),
});

const saveRevisionSchema = z.object({
  revision_id: z.string().trim().min(1).max(64),
  lines: z.array(revisionLineInputSchema).min(1).max(100),
  discount_vnd: vndAmount.optional(),
  fees_vnd: vndAmount.optional(),
  valid_until: z.string().trim().max(40).nullish(),
  conditions_note: z.string().trim().max(2000).nullish(),
});

const issueRevisionSchema = z.object({
  revision_id: z.string().trim().min(1).max(64),
});

const reviseIssuedSchema = z.object({
  revision_id: z.string().trim().min(1).max(64),
  lines: z.array(revisionLineInputSchema).min(1).max(100).optional(),
  discount_vnd: vndAmount.optional(),
  fees_vnd: vndAmount.optional(),
  valid_until: z.string().trim().max(40).nullish(),
  conditions_note: z.string().trim().max(2000).nullish(),
});

const acceptRevisionSchema = z.object({
  revision_id: z.string().trim().min(1).max(64),
  deposit_rate_bps: z.number().int().min(0).max(10000).optional(),
  pilot_credit_vnd: vndAmount.optional(),
  note: z.string().trim().max(1000).nullish(),
});

const transitionOrderSchema = z.object({
  order_id: z.string().trim().min(1).max(64),
  to: z.enum(ORDER_STATUSES),
});

const cancelOrderSchema = z.object({
  order_id: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1).max(500),
});

const createReceiptSchema = z.object({
  order_id: z.string().trim().min(1).max(64),
  amount_vnd: z.number().int().positive(),
  reference: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).nullish(),
});

const confirmReceiptSchema = z.object({
  receipt_id: z.string().trim().min(1).max(64),
  reference: z.string().trim().max(120).optional(),
});

const reverseReceiptSchema = z.object({
  receipt_id: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1).max(500),
});

const createDeliverySchema = z.object({
  order_id: z.string().trim().min(1).max(64),
  scheduled_date: z.string().trim().min(1).max(40),
  delivery_address: z.string().trim().min(1).max(400),
  assigned_to: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(500).nullish(),
  override_under_deposit: z.boolean().optional(),
  override_reason: z.string().trim().max(500).nullish(),
});

const overrideDeliverySchema = z
  .object({
    delivery_id: z.string().trim().min(1).max(64).optional(),
    order_id: z.string().trim().min(1).max(64).optional(),
    scheduled_date: z.string().trim().min(1).max(40).optional(),
    delivery_address: z.string().trim().max(400).optional(),
    assigned_to: z.string().trim().max(120).nullish(),
    note: z.string().trim().max(500).nullish(),
    reason: z.string().trim().min(1).max(500),
  })
  .refine((d) => d.delivery_id !== undefined || d.order_id !== undefined, {
    message: 'Cần cung cấp delivery_id hoặc order_id.',
  });

const updateDeliveryStatusSchema = z.object({
  delivery_id: z.string().trim().min(1).max(64),
  status: z.enum(DELIVERY_STATUSES),
});

const createFollowUpSchema = z.object({
  order_id: z.string().trim().max(64).nullish(),
  customer_id: z.string().trim().min(1).max(64),
  due_date: z.string().trim().min(1).max(40),
  task_kind: z.enum(FOLLOW_UP_KINDS),
  assigned_to: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(500).nullish(),
});

const updateFollowUpSchema = z.object({
  task_id: z.string().trim().min(1).max(64),
  status: z.enum(TASK_STATUSES),
  note: z.string().trim().max(500).nullish(),
});

export async function handleCreateProduct(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = productSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const prodId = `pd-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO products
         (id, workspace_id, name, species, size_class, grade, price_vnd, unit, stock_note, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      prodId,
      workspaceId,
      d.name,
      d.species ?? null,
      d.size_class ?? null,
      d.grade ?? null,
      d.price_vnd,
      d.unit,
      d.stock_note ?? null,
      now,
      now,
    )
    .run();

  return json(
    {
      product: {
        id: prodId,
        name: d.name,
        species: d.species ?? null,
        size_class: d.size_class ?? null,
        grade: d.grade ?? null,
        price_vnd: d.price_vnd,
        unit: d.unit,
        stock_note: d.stock_note ?? null,
      },
    },
    201,
  );
}

export async function handleCreateCustomer(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = customerSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const custId = `cu-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO customers
         (id, workspace_id, name, contact_name, phone, address, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      custId,
      workspaceId,
      d.name,
      d.contact_name ?? null,
      d.phone ?? null,
      d.address ?? null,
      d.note ?? null,
      now,
      now,
    )
    .run();

  return json(
    {
      customer: {
        id: custId,
        workspace_id: workspaceId,
        name: d.name,
        contact_name: d.contact_name ?? null,
        phone: d.phone ?? null,
        address: d.address ?? null,
        note: d.note ?? null,
        created_at: now,
        updated_at: now,
      },
    },
    201,
  );
}

export async function handleTodaySummary({
  workspaceId,
  db,
}: OpsRequest): Promise<Response> {
  const today = new Date().toISOString().slice(0, 10);
  const summary = await readTodaySummary(db, workspaceId, today);
  return json({ summary });
}

export async function handleListQuoteChains({
  workspaceId,
  db,
}: OpsRequest): Promise<Response> {
  const chains = await listQuoteChains(db, workspaceId);
  return json({ chains });
}

export async function handleCreateQuoteChain(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = createChainSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await createChainWithDraft(db, {
    workspaceId,
    customerId: d.customer_id,
    reference: d.reference,
    lines: d.lines.map((l) => ({
      product_id: l.product_id,
      quantity: l.quantity,
      discount_vnd: l.discount_vnd,
      note: l.note ?? null,
    })),
    discountVnd: d.discount_vnd ?? 0,
    feesVnd: d.fees_vnd ?? 0,
    validUntil: d.valid_until ?? null,
    conditionsNote: d.conditions_note ?? null,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json(result.value, 201);
}

export async function handleSaveDraftRevision(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = saveRevisionSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await saveDraftRevision(db, {
    workspaceId,
    revisionId: d.revision_id,
    lines: d.lines.map((l) => ({
      product_id: l.product_id,
      quantity: l.quantity,
      discount_vnd: l.discount_vnd,
      note: l.note ?? null,
    })),
    discountVnd: d.discount_vnd ?? 0,
    feesVnd: d.fees_vnd ?? 0,
    validUntil: d.valid_until ?? null,
    conditionsNote: d.conditions_note ?? null,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ revision: result.value });
}

export async function handleIssueRevision(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = issueRevisionSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const result = await issueRevision(db, workspaceId, parsed.data.revision_id);
  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ revision: result.value });
}

export async function handleReviseQuote(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = reviseIssuedSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await reviseIssued(db, {
    workspaceId,
    revisionId: d.revision_id,
    lines: d.lines?.map((l) => ({
      product_id: l.product_id,
      quantity: l.quantity,
      discount_vnd: l.discount_vnd,
      note: l.note ?? null,
    })),
    discountVnd: d.discount_vnd,
    feesVnd: d.fees_vnd,
    validUntil: d.valid_until,
    conditionsNote: d.conditions_note,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ revision: result.value }, 201);
}

export async function handleAcceptRevision(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = acceptRevisionSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await acceptRevision(db, {
    workspaceId,
    revisionId: d.revision_id,
    depositRateBps: d.deposit_rate_bps ?? 3000,
    pilotCreditVnd: d.pilot_credit_vnd ?? 0,
    note: d.note ?? null,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json(result.value, result.value.created ? 201 : 200);
}

export async function handlePrintableQuote(
  { workspaceId, db, demo }: OpsActorRequest,
  searchParams: URLSearchParams,
): Promise<Response> {
  const revisionId = (searchParams.get('revision_id') ?? '').trim();
  if (revisionId === '') return apiError('Thiếu revision_id để xuất bản in.', 400);

  if (searchParams.get('format') === 'json') {
    const revision = await readRevision(db, workspaceId, revisionId);
    if (revision === null) return apiError('Không tìm thấy phiên bản báo giá.', 404);

    const chain = await db
      .prepare(
        `SELECT qc.reference, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address
           FROM quote_chains qc
           JOIN customers c ON c.id = qc.customer_id
          WHERE qc.id = ? AND qc.workspace_id = ?`,
      )
      .bind(revision.chain_id, workspaceId)
      .first<{
        reference: string;
        customer_name: string;
        customer_phone: string | null;
        customer_address: string | null;
      }>();

    return json({
      printable: {
        demo_banner: demo ? 'DỮ LIỆU MẪU (DEMO) — KHÔNG PHẢI GIAO DỊCH THẬT' : null,
        legal_disclaimer: 'BÁO GIÁ — KHÔNG PHẢI HÓA ĐƠN THUẾ',
        reference: chain?.reference ?? revision.chain_id,
        revision_code: `REV-${revision.revision_number}`,
        status: revision.status,
        customer_name: chain?.customer_name ?? '',
        customer_phone: chain?.customer_phone ?? null,
        customer_address: chain?.customer_address ?? null,
        lines: JSON.parse(revision.lines_json) as unknown[],
        subtotal_vnd: revision.subtotal_vnd,
        discount_vnd: revision.discount_vnd,
        fees_vnd: revision.fees_vnd,
        total_vnd: revision.total_vnd,
        valid_until: revision.valid_until,
        conditions_note: revision.conditions_note,
        issued_at: revision.issued_at,
      },
    });
  }

  const htmlRes = await getPrintableQuoteHtml(db, {
    workspaceId,
    revisionId,
    demo: demo ?? false,
    demoLabel: demo ? DEMO_IDENTITY_LABEL : undefined,
  });
  if (htmlRes.kind === 'refused') return apiError(htmlRes.message, htmlRes.status);

  return new Response(htmlRes.value, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function handleListOrders({
  workspaceId,
  db,
}: OpsRequest): Promise<Response> {
  const orders = await listOrders(db, workspaceId);
  return json({ orders });
}

export async function handleTransitionOrder(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = transitionOrderSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const result = await transitionOrder(db, {
    workspaceId,
    orderId: parsed.data.order_id,
    to: parsed.data.to as OrderStatus,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ order: result.value });
}

export async function handleCancelOrder(
  { workspaceId, db, actorId }: OpsActorRequest,
  body: unknown,
): Promise<Response> {
  const parsed = cancelOrderSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const result = await cancelOrder(db, {
    workspaceId,
    orderId: parsed.data.order_id,
    actorId,
    reason: parsed.data.reason,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ order: result.value });
}

export async function handleListReceipts(
  { workspaceId, db }: OpsRequest,
  searchParams: URLSearchParams,
): Promise<Response> {
  const orderId = searchParams.get('order_id') ?? undefined;
  const receipts = await listReceipts(db, workspaceId, orderId);
  return json({ receipts });
}

export async function handleCreateReceipt(
  { workspaceId, db, actorId }: OpsActorRequest,
  body: unknown,
): Promise<Response> {
  const parsed = createReceiptSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await createReceipt(db, {
    workspaceId,
    orderId: d.order_id,
    amountVnd: d.amount_vnd,
    reference: d.reference,
    actorId,
    note: d.note ?? null,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ receipt: result.value }, 201);
}

export async function handleConfirmReceipt(
  { workspaceId, db, actorId }: OpsActorRequest,
  body: unknown,
): Promise<Response> {
  const parsed = confirmReceiptSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await confirmReceipt(db, {
    workspaceId,
    receiptId: d.receipt_id,
    actorId,
    reference: d.reference,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json(result.value);
}

export async function handleReverseReceipt(
  { workspaceId, db, actorId }: OpsActorRequest,
  body: unknown,
): Promise<Response> {
  const parsed = reverseReceiptSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await reverseReceipt(db, {
    workspaceId,
    receiptId: d.receipt_id,
    actorId,
    reason: d.reason,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json(result.value);
}

export async function handleListDeliveries({
  workspaceId,
  db,
}: OpsRequest): Promise<Response> {
  const deliveries = await listDeliveries(db, workspaceId);
  return json({ deliveries });
}

export async function handleCreateDelivery(
  { workspaceId, db, actorId }: OpsActorRequest,
  body: unknown,
): Promise<Response> {
  const parsed = createDeliverySchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await createDelivery(db, {
    workspaceId,
    orderId: d.order_id,
    scheduledDate: d.scheduled_date,
    deliveryAddress: d.delivery_address,
    assignedTo: d.assigned_to ?? null,
    note: d.note ?? null,
    overrideUnderDeposit: d.override_under_deposit ?? false,
    overrideReason: d.override_reason ?? null,
    overrideBy: d.override_under_deposit ? actorId : null,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ delivery: result.value }, 201);
}

export async function handleOverrideDelivery(
  { workspaceId, db, actorId }: OpsActorRequest,
  body: unknown,
): Promise<Response> {
  const parsed = overrideDeliverySchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await overrideUnderDepositDelivery(db, {
    workspaceId,
    deliveryId: d.delivery_id,
    orderId: d.order_id,
    scheduledDate: d.scheduled_date,
    deliveryAddress: d.delivery_address,
    assignedTo: d.assigned_to ?? null,
    note: d.note ?? null,
    actorId,
    reason: d.reason,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ delivery: result.value });
}

export async function handleUpdateDeliveryStatus(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = updateDeliveryStatusSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await updateDeliveryStatus(db, {
    workspaceId,
    deliveryId: d.delivery_id,
    status: d.status as DeliveryStatus,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ delivery: result.value });
}

export async function handleListFollowUpTasks(
  { workspaceId, db }: OpsRequest,
  searchParams: URLSearchParams,
): Promise<Response> {
  const statusParam = searchParams.get('status') ?? undefined;
  const status =
    statusParam && (TASK_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as TaskStatus)
      : undefined;
  const tasks = await listFollowUpTasks(db, workspaceId, status);
  return json({ tasks });
}

export async function handleCreateFollowUpTask(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = createFollowUpSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await createFollowUpTask(db, {
    workspaceId,
    orderId: d.order_id ?? null,
    customerId: d.customer_id,
    dueDate: d.due_date,
    taskKind: d.task_kind as FollowUpKind,
    assignedTo: d.assigned_to ?? null,
    note: d.note ?? null,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ task: result.value }, 201);
}

export async function handleUpdateFollowUpTask(
  { workspaceId, db }: OpsRequest,
  body: unknown,
): Promise<Response> {
  const parsed = updateFollowUpSchema.safeParse(body);
  if (!parsed.success) return apiError(validationMessage(parsed.error), 400);

  const d = parsed.data;
  const result = await updateFollowUpTask(db, {
    workspaceId,
    taskId: d.task_id,
    status: d.status as TaskStatus,
    note: d.note ?? null,
  });

  if (result.kind === 'refused') return apiError(result.message, result.status);
  return json({ task: result.value });
}

export type { CustomerRow, ProductRow, QuoteDraftRow };
