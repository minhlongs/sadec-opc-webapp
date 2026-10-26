/**
 * Catalog reads and writes for the ops area.
 *
 * Every function takes a workspace id as its first argument and puts it in the
 * statement's WHERE clause, so a query without one is not expressible. §14 asks
 * for tenancy to be enforced by the database rather than filtered in the UI, and
 * the strongest version of that is a helper shape that cannot omit the filter.
 */

import { MAX_VND, addVnd } from '../domain/money.ts';
import type { Role } from '../security/authorize.ts';

/** A row as stored. Money is an integer number of dong. */
export interface ProductRow {
  id: string;
  workspace_id: string;
  name: string;
  species: string | null;
  size_class: string | null;
  grade: string | null;
  price_vnd: number;
  unit: string;
  stock_note: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CustomerRow {
  id: string;
  workspace_id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The signed-in session as the browser needs it: enough to render the shell and
 * to label a demo, never enough to re-derive permission.
 *
 * The role travels because §5 requires an operator to see which identity they
 * are acting as — a person who believes they are testing as the owner while
 * acting as an operator has tested the wrong thing. It is read from the
 * membership the chokepoint already resolved, not from the request, and the UI
 * uses it for display only. Every guarded action is re-authorized server-side
 * regardless of what this says.
 */
export interface SessionView {
  accessSubject: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  workspaceId: string;
  /** True only for the labelled demo identity, so the banner can name it. */
  demo: boolean;
  demoLabel: string | null;
}

export interface QuoteDraftRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  reference: string;
  status: string;
  lines_json: string;
  subtotal_vnd: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** One line of a quote draft, as the client sends it. */
export interface QuoteLineDraft {
  product_id: string;
  quantity: number;
  note: string | null;
}

/** A line with the server's price filled in. What is stored and returned. */
export interface PricedQuoteLine {
  product_id: string;
  product_name: string;
  unit: string;
  /** The unit price read from the products table at save time. */
  unit_price_vnd: number;
  quantity: number;
  line_total_vnd: number;
  note: string | null;
}

/**
 * The minimum shape this module needs from D1, so a test can supply its own.
 *
 * Declared once here and imported by the Worker rather than restated there, so
 * two definitions cannot drift — an interface duplicated in two files eventually
 * disagrees, and the disagreement surfaces as a route that typechecks against a
 * database it cannot actually query.
 *
 * The methods are generic over the row type, because a row is not
 * `Record<string, unknown>` once it reaches a caller: it has an `id`, a
 * `price_vnd` and a `status`, and a caller that has to cast each one is a caller
 * that can cast wrongly.
 */
export interface D1Statement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export type D1PreparedStatement = D1Statement & {
  bind(...values: unknown[]): D1Statement;
};

export interface D1Result<T> {
  results: T[];
}

export interface D1Like {
  prepare(query: string): D1Statement & {
    bind(...values: unknown[]): D1Statement;
  };
  batch<T>(statements: T[]): Promise<unknown>;
}

const nowIso = () => new Date().toISOString();

export async function listProducts(
  db: D1Like,
  workspaceId: string,
): Promise<ProductRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, name, species, size_class, grade, price_vnd,
              unit, stock_note, is_active, created_at, updated_at
         FROM products
        WHERE workspace_id = ? AND is_active = 1
        ORDER BY name, size_class`,
    )
    .bind(workspaceId)
    .all<ProductRow>();
  return results;
}

export async function listCustomers(
  db: D1Like,
  workspaceId: string,
): Promise<CustomerRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, name, contact_name, phone, address, note,
              created_at, updated_at
         FROM customers
        WHERE workspace_id = ?
        ORDER BY name`,
    )
    .bind(workspaceId)
    .all<CustomerRow>();
  return results;
}

/**
 * Reads the session's identity row, scoped to the workspace the chokepoint
 * resolved.
 *
 * The subject is bound rather than interpolated, and the workspace is in the
 * WHERE clause like every other query here, so an identity that holds no
 * membership in this workspace finds nothing — which is the same refusal the
 * guard already gave, expressed in a read rather than in a guard.
 */
export async function findIdentity(
  db: D1Like,
  workspaceId: string,
  accessSubject: string,
): Promise<{ display_name: string | null; email: string | null } | null> {
  return db
    .prepare(
      `SELECT i.display_name AS display_name, i.email AS email
         FROM identities i
         JOIN memberships m ON m.identity_id = i.id AND m.workspace_id = ?
        WHERE i.access_sub = ? AND m.revoked_at IS NULL`,
    )
    .bind(workspaceId, accessSubject)
    .first<{ display_name: string | null; email: string | null }>();
}

export async function findCustomer(
  db: D1Like,
  workspaceId: string,
  customerId: string,
): Promise<CustomerRow | null> {
  return db
    .prepare(
      `SELECT id, workspace_id, name, contact_name, phone, address, note,
              created_at, updated_at
         FROM customers
        WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, customerId)
    .first<CustomerRow>();
}

/**
 * Prices the draft's lines against the catalog at save time.
 *
 * The unit price comes from the products table, never from the request. This is
 * the single place a quote's money is decided, so a client that sends a lower
 * price than the catalog holds has changed nothing — which is §7's requirement
 * that a total is computed by the server rather than trusted.
 */
export async function priceQuoteLines(
  db: D1Like,
  workspaceId: string,
  lines: readonly QuoteLineDraft[],
): Promise<PricedQuoteLine[] | null> {
  const priced: PricedQuoteLine[] = [];

  for (const line of lines) {
    const product = await db
      .prepare(
        `SELECT id, name, unit, price_vnd
           FROM products
          WHERE workspace_id = ? AND id = ? AND is_active = 1`,
      )
      .bind(workspaceId, line.product_id)
      .first<{ id: string; name: string; unit: string; price_vnd: number }>();

    // An unknown or inactive product is a refusal for the whole draft, not a
    // skipped line. A quote silently missing a line the customer asked for is
    // worse than one that fails to save.
    if (product === null) return null;

    priced.push({
      product_id: product.id,
      product_name: product.name,
      unit: product.unit,
      unit_price_vnd: product.price_vnd,
      quantity: line.quantity,
      line_total_vnd: multiplyVnd(product.price_vnd, line.quantity),
      note: line.note,
    });
  }

  return priced;
}

/**
 * Multiplies a unit price by a quantity, guarding against the overflow and
 * fraction the domain module refuses.
 *
 * A quote line is the boundary where a number from a form first meets the money
 * rules, so it routes through the same guards as every other monetary value
 * rather than trusting that a quantity is small. A quantity is bounded by the
 * schema at 100,000, but a caller that reaches this function from another path
 * should still get a refusal rather than a wrapped total.
 */
export function multiplyVnd(unitPrice: number, quantity: number): number {
  if (!Number.isInteger(unitPrice) || !Number.isInteger(quantity)) {
    throw new RangeError('A quote line needs an integer unit price and quantity.');
  }
  if (quantity < 0) {
    throw new RangeError('A quote line quantity cannot be negative.');
  }
  const total = unitPrice * quantity;
  if (!Number.isFinite(total) || Math.abs(total) > MAX_VND) {
    throw new RangeError(
      `${quantity} × ${unitPrice} cannot exceed the safe bound of ${MAX_VND}`,
    );
  }
  return total;
}

/**
 * Sums priced lines into the draft's subtotal.
 *
 * Summation is separate from pricing so the guard is applied once to the total
 * rather than once per line, and so a later rate or discount applied at the
 * draft level has one place to enter.
 *
 * The addition routes through the domain guard, so a total that would leave the
 * safe integer range throws rather than silently wrapping — a wrapped total is a
 * quote that looks plausible and is wrong by billions.
 */
export function subtotalOf(lines: readonly PricedQuoteLine[]): number {
  return lines.reduce((total, line) => addVnd(total, line.line_total_vnd), 0);
}

export async function saveQuoteDraft(
  db: D1Like,
  input: {
    workspaceId: string;
    customerId: string;
    reference: string;
    lines: readonly QuoteLineDraft[];
    note: string | null;
  },
): Promise<{ draft: QuoteDraftRow; lines: PricedQuoteLine[]; subtotal: number } | null> {
  const customer = await findCustomer(db, input.workspaceId, input.customerId);
  if (customer === null) return null;

  const priced = await priceQuoteLines(db, input.workspaceId, input.lines);
  if (priced === null) return null;

  const subtotal = subtotalOf(priced);
  const timestamp = nowIso();

  // One live draft per customer per workspace, which the migration enforces with
  // a partial unique index. Saving again updates the same draft rather than
  // starting a second one, so an operator re-opening a quote sees what they left.
  await db
    .prepare(
      `INSERT INTO quote_drafts
         (id, workspace_id, customer_id, reference, status, lines_json,
          subtotal_vnd, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, customer_id) WHERE status = 'draft'
       DO UPDATE SET
         reference = excluded.reference,
         lines_json = excluded.lines_json,
         subtotal_vnd = excluded.subtotal_vnd,
         note = excluded.note,
         updated_at = excluded.updated_at
      `,
    )
    .bind(
      crypto.randomUUID(),
      input.workspaceId,
      input.customerId,
      input.reference,
      JSON.stringify(priced),
      subtotal,
      input.note,
      timestamp,
      timestamp,
    )
    .run();

  const draft = await db
    .prepare(
      `SELECT id, workspace_id, customer_id, reference, status, lines_json,
              subtotal_vnd, note, created_at, updated_at
         FROM quote_drafts
        WHERE workspace_id = ? AND customer_id = ? AND status = 'draft'`,
    )
    .bind(input.workspaceId, input.customerId)
    .first<QuoteDraftRow>();

  if (draft === null) return null;
  return { draft, lines: priced, subtotal };
}

export async function listQuoteDrafts(
  db: D1Like,
  workspaceId: string,
): Promise<QuoteDraftRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, customer_id, reference, status, lines_json,
              subtotal_vnd, note, created_at, updated_at
         FROM quote_drafts
        WHERE workspace_id = ?
        ORDER BY updated_at DESC`,
    )
    .bind(workspaceId)
    .all<QuoteDraftRow>();
  return results;
}
