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
} from './catalog.ts';

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

export type { CustomerRow, ProductRow, QuoteDraftRow };
