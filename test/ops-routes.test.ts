import { describe, expect, it } from 'vitest';
import {
  handleListProducts,
  handleListCustomers,
  handleListQuoteDrafts,
  handleSaveQuoteDraft,
  handleSession,
} from '../src/ops/routes.ts';
import {
  priceQuoteLines,
  subtotalOf,
  multiplyVnd,
  type D1Like,
  type ProductRow,
  type CustomerRow,
  type QuoteDraftRow,
} from '../src/ops/catalog.ts';
import { MAX_VND } from '../src/domain/money.ts';

/**
 * The membership the session route joins against. Declared here rather than
 * imported because the stand-in models the joined row, not the memberships row.
 */
interface MembershipStub {
  access_sub: string;
  workspace_id: string;
  email: string | null;
  display_name: string | null;
}

/**
 * The ops routes are where a browser first touches money and tenancy, so the
 * tests here check the two things a UI cannot check for itself: that a total is
 * computed from the catalog rather than from the request, and that a query
 * cannot omit its workspace.
 */

/** A D1 stand-in holding one workspace's rows, keyed for the queries issued. */
class FakeD1 implements D1Like {
  readonly products: ProductRow[] = [];
  readonly customers: CustomerRow[] = [];
  readonly drafts: QuoteDraftRow[] = [];
  readonly memberships: MembershipStub[] = [];

  prepare(query: string) {
    const run = () => this.run(query);
    const statement = {
      first: async <T,>(): Promise<T | null> => (this.first<T>(query) ?? null),
      all: async <T,>(): Promise<{ results: T[] }> => ({ results: this.all<T>(query) }),
      run,
      bind: (...values: unknown[]) => ({
        bound: values,
        first: async <T,>(): Promise<T | null> =>
          this.first<T>(query, values) ?? null,
        all: async <T,>(): Promise<{ results: T[] }> => ({ results: this.all<T>(query, values) }),
        run: async () => this.run(query, values),
      }),
    };
    return statement as unknown as ReturnType<D1Like['prepare']>;
  }

  batch<T>(statements: T[]): Promise<unknown> {
    return Promise.resolve(statements);
  }

  private first<T>(query: string, bound?: unknown[]): T | null {
    const rows = this.rows(query, bound) as readonly unknown[];
    return (rows[0] as T | undefined) ?? null;
  }

  private all<T>(query: string, bound?: unknown[]): T[] {
    return this.rows(query, bound) as unknown[] as T[];
  }

  private run(query: string, bound?: unknown[]): { meta: { changes: number } } {
    if (/INSERT INTO quote_drafts/i.test(query)) {
      return this.insertDraft(query, bound ?? []);
    }
    return { meta: { changes: 0 } };
  }

  private insertDraft(query: string, bound: unknown[]): { meta: { changes: number } } {
    const [id, workspaceId, customerId, reference, linesJson, subtotal, note, createdAt, updatedAt] =
      bound;
    const existing = this.drafts.findIndex(
      (draft) =>
        draft.workspace_id === workspaceId &&
        draft.customer_id === customerId &&
        draft.status === 'draft',
    );
    const record: QuoteDraftRow = {
      id: String(id),
      workspace_id: String(workspaceId),
      customer_id: String(customerId),
      reference: String(reference),
      status: 'draft',
      lines_json: String(linesJson),
      subtotal_vnd: Number(subtotal),
      note: note === undefined ? null : String(note),
      created_at: String(createdAt),
      updated_at: String(updatedAt),
    };
    if (existing === -1) this.drafts.push(record);
    else this.drafts[existing] = record;
    return { meta: { changes: 1 } };
  }

  /**
   * Resolves rows for a query, filtering on every bound value the query binds.
   *
   * The stand-in matches on the WHERE clauses the real statements carry rather
   * than on the first parameter alone. Filtering only on `bound[0]` would make a
   * lookup like "the product with this id in this workspace" return the
   * workspace's first product instead — which is a passing test proving nothing.
   */
  private rows(
    query: string,
    bound: unknown[] = [],
  ): (ProductRow | CustomerRow | QuoteDraftRow)[] {
    if (/FROM identities/i.test(query)) {
      // The session lookup joins identities to memberships, so it binds the
      // workspace first and the subject second — the same order the real query
      // does. A subject holding no membership in this workspace finds nothing.
      const subject = bound[1];
      const membership = this.memberships.find(
        (row) => row.access_sub === subject && row.workspace_id === bound[0],
      );
      if (membership === undefined) return [];
      return [
        {
          display_name: membership.display_name,
          email: membership.email,
        } as unknown as CustomerRow,
      ];
    }

    if (/FROM products/i.test(query)) {
      let rows = this.products.filter(
        (row) => row.workspace_id === bound[0],
      );
      // The single-product lookup binds a second value: the product id.
      if (/id = \?/i.test(query) && bound.length > 1) {
        rows = rows.filter((row) => row.id === bound[1]);
      }
      if (/is_active = 1/.test(query)) {
        rows = rows.filter((row) => row.is_active === 1);
      }
      return rows;
    }

    if (/FROM customers/i.test(query)) {
      let rows = this.customers.filter((row) => row.workspace_id === bound[0]);
      if (/id = \?/i.test(query) && bound.length > 1) {
        rows = rows.filter((row) => row.id === bound[1]);
      }
      return rows;
    }

    if (/FROM quote_drafts/i.test(query)) {
      let rows = this.drafts.filter((row) => row.workspace_id === bound[0]);
      if (/customer_id = \?/i.test(query) && bound.length > 1) {
        rows = rows.filter((row) => row.customer_id === bound[1]);
      }
      return rows;
    }

    return [];
  }
}

function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 'pd-1',
    workspace_id: 'ws-a',
    name: 'Cau vàng',
    species: 'Cau vàng',
    size_class: 'M',
    grade: 'A',
    price_vnd: 350000,
    unit: 'chậu',
    stock_note: 'Còn 80 chậu',
    is_active: 1,
    created_at: '2026-10-23T02:00:00.000Z',
    updated_at: '2026-10-23T02:00:00.000Z',
    ...overrides,
  };
}

function customer(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'cu-1',
    workspace_id: 'ws-a',
    name: 'Công ty DEMO',
    contact_name: 'Chị Hương',
    phone: '0900000001',
    address: 'Sa Đéc',
    note: null,
    created_at: '2026-10-23T02:00:00.000Z',
    updated_at: '2026-10-23T02:00:00.000Z',
    ...overrides,
  };
}

function dbWithProductsWorkspaceA(): FakeD1 {
  const db = new FakeD1();
  db.products.push(product(), product({ id: 'pd-2', price_vnd: 180000 }));
  db.customers.push(customer());
  return db;
}

describe('a product price is never taken from the request', () => {
  it('prices a line from the catalog, ignoring any price the client sent', async () => {
    const db = dbWithProductsWorkspaceA();
    const priced = await priceQuoteLines(db, 'ws-a', [
      { product_id: 'pd-1', quantity: 3, note: null },
    ]);
    expect(priced).not.toBeNull();
    expect(priced?.[0]?.unit_price_vnd).toBe(350000);
    expect(priced?.[0]?.line_total_vnd).toBe(1050000);
  });

  it('refuses the whole draft when a line names an unknown product', async () => {
    const db = dbWithProductsWorkspaceA();
    const priced = await priceQuoteLines(db, 'ws-a', [
      { product_id: 'pd-1', quantity: 1, note: null },
      { product_id: 'pd-does-not-exist', quantity: 1, note: null },
    ]);
    // A quote silently missing a line the customer asked for is worse than one
    // that fails to save, so this is a refusal for the whole draft.
    expect(priced).toBeNull();
  });

  it('refuses a line naming an inactive product', async () => {
    const db = new FakeD1();
    db.products.push(product({ id: 'pd-off', is_active: 0 }));
    const priced = await priceQuoteLines(db, 'ws-a', [
      { product_id: 'pd-off', quantity: 1, note: null },
    ]);
    expect(priced).toBeNull();
  });

  it('cannot read a product from another workspace', async () => {
    const db = new FakeD1();
    db.products.push(product({ id: 'pd-b', workspace_id: 'ws-b' }));
    const priced = await priceQuoteLines(db, 'ws-a', [
      { product_id: 'pd-b', quantity: 1, note: null },
    ]);
    // Not a permission error the caller can see — simply absent.
    expect(priced).toBeNull();
  });
});

describe('money arithmetic at the quote line', () => {
  it('multiplies a unit price by a quantity in integer dong', () => {
    expect(multiplyVnd(350000, 3)).toBe(1050000);
  });

  it('refuses a fractional price or quantity rather than rounding it', () => {
    expect(() => multiplyVnd(350000.5, 1)).toThrow(RangeError);
    expect(() => multiplyVnd(350000, 1.5)).toThrow(RangeError);
  });

  it('refuses a negative quantity', () => {
    expect(() => multiplyVnd(350000, -1)).toThrow(RangeError);
  });

  it('sums lines through the domain guard, so an overflow is an error not a wrap', () => {
    // A quantity chosen so the product would pass a plain JS multiply without
    // complaint, while the total leaves the safe range the domain guards.
    const huge = Math.ceil(MAX_VND / 350000) + 1;
    const priced = [
      {
        product_id: 'pd-1',
        product_name: 'Cau vàng',
        unit: 'chậu',
        unit_price_vnd: 350000,
        quantity: huge,
        line_total_vnd: 350000 * huge,
        note: null,
      },
    ];
    expect(() => subtotalOf(priced)).toThrow(RangeError);
  });
});

describe('saving a quote draft', () => {
  it('stores the server-computed subtotal and returns the priced lines', async () => {
    const db = dbWithProductsWorkspaceA();
    const response = await handleSaveQuoteDraft(
      { workspaceId: 'ws-a', db },
      {
        customer_id: 'cu-1',
        reference: 'BG-0001',
        lines: [
          { product_id: 'pd-1', quantity: 2, note: null },
          { product_id: 'pd-2', quantity: 5, note: null },
        ],
        note: null,
      },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      draft: { subtotal_vnd: number; lines: { line_total_vnd: number }[] };
    };
    expect(body.draft.subtotal_vnd).toBe(2 * 350000 + 5 * 180000);
    expect(body.draft.lines).toHaveLength(2);
  });

  it('does not create a second draft for the same customer', async () => {
    const db = dbWithProductsWorkspaceA();
    const payload = {
      customer_id: 'cu-1',
      reference: 'BG-0001',
      lines: [{ product_id: 'pd-1', quantity: 1, note: null }],
      note: null,
    };
    await handleSaveQuoteDraft({ workspaceId: 'ws-a', db }, payload);
    await handleSaveQuoteDraft({ workspaceId: 'ws-a', db }, {
      ...payload,
      reference: 'BG-0001-r2',
      lines: [{ product_id: 'pd-1', quantity: 4, note: null }],
    });

    expect(db.drafts).toHaveLength(1);
    // The second save updates in place, so re-opening a quote shows what was
    // left rather than a parallel draft the other operator cannot see.
    expect(db.drafts[0]?.reference).toBe('BG-0001-r2');
    expect(db.drafts[0]?.subtotal_vnd).toBe(4 * 350000);
  });

  it('refuses a draft whose customer is in another workspace', async () => {
    const db = dbWithProductsWorkspaceA();
    const response = await handleSaveQuoteDraft(
      { workspaceId: 'ws-a', db },
      {
        customer_id: 'cu-elsewhere',
        reference: 'BG-0002',
        lines: [{ product_id: 'pd-1', quantity: 1, note: null }],
        note: null,
      },
    );
    expect(response.status).toBe(400);
    expect(db.drafts).toHaveLength(0);
  });

  it('refuses a body with no lines', async () => {
    const db = dbWithProductsWorkspaceA();
    const response = await handleSaveQuoteDraft(
      { workspaceId: 'ws-a', db },
      { customer_id: 'cu-1', reference: 'BG-0003', lines: [], note: null },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('lines');
  });

  it('refuses a money value sent as a string rather than coercing it', async () => {
    const db = dbWithProductsWorkspaceA();
    const response = await handleSaveQuoteDraft(
      { workspaceId: 'ws-a', db },
      {
        customer_id: 'cu-1',
        reference: 'BG-0004',
        // A client that sends "1" is a client whose other values cannot be
        // assumed to be what they claim, so the field is refused not guessed.
        lines: [{ product_id: 'pd-1', quantity: '2', note: null }],
        note: null,
      },
    );
    expect(response.status).toBe(400);
    expect(db.drafts).toHaveLength(0);
  });

  it('names the field that failed in the message', async () => {
    const db = dbWithProductsWorkspaceA();
    const response = await handleSaveQuoteDraft(
      { workspaceId: 'ws-a', db },
      { customer_id: '', reference: 'BG-0005', lines: [{ product_id: 'pd-1', quantity: 1, note: null }], note: null },
    );
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('customer_id');
  });
});

describe('reads stay inside their workspace', () => {
  it('lists only the workspace’s own products', async () => {
    const db = dbWithProductsWorkspaceA();
    db.products.push(product({ id: 'pd-b', workspace_id: 'ws-b' }));
    const response = await handleListProducts({ workspaceId: 'ws-a', db });
    const body = (await response.json()) as { products: { id: string }[] };
    expect(body.products.map((row) => row.id).sort()).toEqual(['pd-1', 'pd-2']);
  });

  it('returns an empty list rather than another workspace’s customers', async () => {
    const db = new FakeD1();
    db.customers.push(customer({ id: 'cu-b', workspace_id: 'ws-b' }));
    const response = await handleListCustomers({ workspaceId: 'ws-a', db });
    const body = (await response.json()) as { customers: unknown[] };
    expect(body.customers).toHaveLength(0);
  });

  it('parses stored line JSON back into objects on read', async () => {

    const db = dbWithProductsWorkspaceA();
    await handleSaveQuoteDraft(
      { workspaceId: 'ws-a', db },
      {
        customer_id: 'cu-1',
        reference: 'BG-0006',
        lines: [{ product_id: 'pd-1', quantity: 2, note: null }],
        note: null,
      },
    );
    const response = await handleListQuoteDrafts({ workspaceId: 'ws-a', db });
    const body = (await response.json()) as {
      drafts: { lines: { product_id: string; quantity: number }[] }[];
    };
    expect(body.drafts[0]?.lines[0]?.quantity).toBe(2);
  });
});

/**
 * The session route is the one place a browser asks "who am I acting as". What
 * matters is not that it answers, but that it answers from the membership the
 * chokepoint resolved rather than from anything the client sent — a route that
 * echoed a requested role would turn §5's "see which identity you are" into a
 * way to look like an owner.
 */
describe('the session route reports the role the chokepoint resolved', () => {
  function dbWithMembership(): FakeD1 {
    const db = new FakeD1();
    db.memberships.push({
      access_sub: 'sub-operator',
      workspace_id: 'ws-a',
      email: 'operator@example.test',
      display_name: 'DEMO — Nhân viên',
    });
    return db;
  }

  it('returns the workspace and role it was handed, not a second lookup', async () => {
    const response = await handleSession({
      db: dbWithMembership(),
      workspaceId: 'ws-a',
      role: 'workspace_operator',
      identity: { accessSubject: 'sub-operator', email: null, demo: true },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { role: string; workspaceId: string; demo: boolean };
    };
    expect(body.session.role).toBe('workspace_operator');
    // The workspace comes from the authorization, so a tampered value in the UI
    // cannot widen the scope the following requests are made in.
    expect(body.session.workspaceId).toBe('ws-a');
  });

  it('carries a demo label only for a demo session', async () => {
    const demo = await handleSession({
      db: dbWithMembership(),
      workspaceId: 'ws-a',
      role: 'workspace_operator',
      identity: { accessSubject: 'sub-operator', email: null, demo: true },
    });
    expect(((await demo.json()) as { session: { demoLabel: string | null } }).session.demoLabel)
      .toContain('DEMO');

    const real = await handleSession({
      db: dbWithMembership(),
      workspaceId: 'ws-a',
      role: 'workspace_operator',
      identity: { accessSubject: 'sub-operator', email: null, demo: false },
    });
    expect(((await real.json()) as { session: { demoLabel: string | null } }).session.demoLabel)
      .toBeNull();
  });

  it('finds nothing for a subject with no membership in the workspace', async () => {
    // The join is scoped to the workspace, so a subject granted elsewhere reads
    // as absent here rather than borrowing another workspace's display name.
    const response = await handleSession({
      db: dbWithMembership(),
      workspaceId: 'ws-a',
      role: 'workspace_operator',
      identity: { accessSubject: 'sub-nobody', email: null, demo: false },
    });

    const body = (await response.json()) as { session: { displayName: string | null } };
    expect(body.session.displayName).toBeNull();
  });

  it('reports the display name the database holds, so the UI needs no second source', async () => {
    const response = await handleSession({
      db: dbWithMembership(),
      workspaceId: 'ws-a',
      role: 'founder_admin',
      identity: { accessSubject: 'sub-operator', email: null, demo: false },
    });
    const body = (await response.json()) as {
      session: { displayName: string | null; email: string | null };
    };
    expect(body.session.displayName).toBe('DEMO — Nhân viên');
    expect(body.session.email).toBe('operator@example.test');
  });
});
