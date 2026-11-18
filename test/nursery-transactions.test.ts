/**
 * Nursery write paths against a real SQLite schema (migrations 0001–0005 +
 * demo seed), proving the Phase C rules:
 *
 *   - every write is recorded against the caller, who must be a live member of
 *     the workspace — never a substitute member, never a seeded id;
 *   - accepting a quote, confirming or reversing a receipt, scheduling a
 *     delivery and cancelling an order are each one transaction whose business
 *     condition lives in SQL, so a lost race leaves nothing half-written;
 *   - the client names neither the deposit rate nor a pilot credit;
 *   - a receipt cannot be recorded or confirmed past what the order still owes;
 *   - an operator cannot deliver under deposit through the create route.
 *
 * "Concurrent" here means two calls whose reads interleave before either
 * writes, which is the shape D1 produces: `batch` is a transaction, not a row
 * lock. Where a deterministic interleaving is needed, the harness runs a
 * competing write immediately before the batch under test.
 */

import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createSqliteD1 } from './sqlite-d1-harness.ts';
import type { D1Like } from '../src/ops/catalog.ts';
import {
  acceptRevision,
  cancelOrder,
  confirmReceipt,
  createCustomer,
  createDelivery,
  createFollowUpTask,
  createProduct,
  createQuoteChain,
  createReceipt,
  getPrintableQuoteHtml,
  issueRevision,
  overrideUnderDepositDelivery,
  readOrder,
  readRevision,
  readTodaySummary,
  reverseReceipt,
  reviseIssued,
  transitionOrder,
  updateCustomer,
  updateDeliveryStatus,
  updateProduct,
  voidReceipt,
} from '../src/ops/transactions.ts';
import { DEFAULT_DEPOSIT_RATE_BPS } from '../src/ops/quote-revisions.ts';
import {
  handleAcceptRevision,
  handleCreateDelivery,
  handleCreateReceipt,
  handleListCustomers,
  handleListProducts,
  handlePrintableQuote,
  handleTransitionOrder,
  handleUpdateCustomer,
  handleUpdateProduct,
  handleVoidReceipt,
  type OpsActorRequest,
} from '../src/ops/routes.ts';
import worker from '../src/worker/index.ts';
import type { Role } from '../src/security/authorize.ts';

const WS = 'ws-demo-a';
const OWNER = 'id-demo-owner';
const OPERATOR = 'id-demo-operator';
/** A real identity that holds no membership in ws-demo-a. */
const STRANGER = 'id-stranger';

function count(raw: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = raw.prepare(sql).get(...params) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

function withStranger(raw: DatabaseSync): void {
  raw
    .prepare(
      `INSERT INTO identities (id, access_sub, email, display_name, created_at)
       VALUES (?, 'demo:sub:stranger', 'stranger@example.test', 'Người lạ', '2026-10-29T00:00:00.000Z')`,
    )
    .run(STRANGER);
}

/** A D1 whose `batch` is preceded by a competing write — the losing side of a race. */
function racing(db: D1Like, before: () => void): D1Like {
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async <T>(statements: T[]) => {
      before();
      return db.batch(statements);
    },
  };
}

function actorRequest(db: D1Like, actorId: string, role: Role): OpsActorRequest {
  return { workspaceId: WS, db, actorId, role, demo: true };
}

/** An issued revision of a fresh chain, with no order yet. */
async function issuedQuote(db: D1Like, reference: string, unitPriceVnd = 1_000_000, quantity = 10) {
  const customer = await createCustomer(db, { workspaceId: WS, name: `Khách ${reference}` });
  if (customer.kind !== 'ok') throw new Error(customer.message);
  const chain = await createQuoteChain(db, {
    workspaceId: WS,
    customerId: customer.value.id,
    reference,
    lines: [{ product_name: 'Mai vàng', quantity, unit: 'cây', unit_price_vnd: unitPriceVnd }],
  });
  if (chain.kind !== 'ok') throw new Error(chain.message);
  const revisionId = chain.value.revisions[0]!.id;
  const issued = await issueRevision(db, { workspaceId: WS, revisionId });
  if (issued.kind !== 'ok') throw new Error(issued.message);
  return { revisionId, chainId: chain.value.id, totalVnd: unitPriceVnd * quantity };
}

async function acceptedOrder(db: D1Like, reference: string, unitPriceVnd = 1_000_000, quantity = 10) {
  const quote = await issuedQuote(db, reference, unitPriceVnd, quantity);
  const accepted = await acceptRevision(db, { workspaceId: WS, revisionId: quote.revisionId, actorId: OPERATOR });
  if (accepted.kind !== 'ok') throw new Error(accepted.message);
  return { ...quote, order: accepted.value.order };
}

describe('the actor of a nursery write is the caller, a live member, and nobody else', () => {
  const cases: {
    name: string;
    run: (db: D1Like, actorId: string | undefined) => Promise<{ kind: string; status?: number; code?: string }>;
  }[] = [
    {
      name: 'accept a quote',
      run: (db, actorId) => acceptRevision(db, { workspaceId: WS, revisionId: 'qr-demo-02-r1', actorId }),
    },
    {
      name: 'record a receipt',
      run: (db, actorId) =>
        createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 1_000_000, actorId }),
    },
    {
      name: 'confirm a receipt',
      run: (db, actorId) => confirmReceipt(db, { workspaceId: WS, receiptId: 'rc-demo-01', actorId }),
    },
    {
      name: 'reverse a receipt',
      run: (db, actorId) =>
        reverseReceipt(db, { workspaceId: WS, receiptId: 'rc-demo-01', reason: 'Nhầm', actorId }),
    },
    {
      name: 'schedule a delivery',
      run: (db, actorId) =>
        createDelivery(db, { workspaceId: WS, orderId: 'ord-demo-01', scheduledDate: '2026-11-01', actorId }),
    },
    {
      name: 'override under deposit',
      run: (db, actorId) =>
        overrideUnderDepositDelivery(db, { workspaceId: WS, deliveryId: 'dlv-demo-01', reason: 'Khách quen', actorId }),
    },
    {
      name: 'move a delivery',
      run: (db, actorId) =>
        updateDeliveryStatus(db, { workspaceId: WS, deliveryId: 'dlv-demo-01', status: 'in_transit', actorId }),
    },
    {
      name: 'transition an order',
      run: (db, actorId) => transitionOrder(db, { workspaceId: WS, orderId: 'ord-demo-01', to: 'delivered', actorId }),
    },
    {
      name: 'cancel an order',
      run: (db, actorId) => cancelOrder(db, { workspaceId: WS, orderId: 'ord-demo-01', reason: 'Khách hủy', actorId }),
    },
  ];

  for (const c of cases) {
    it(`refuses to ${c.name} without an actor, for a non-member, and for a revoked member`, async () => {
      const { db, raw } = createSqliteD1({ seedDemo: true });
      withStranger(raw);
      const before = {
        audit: count(raw, `SELECT COUNT(*) AS n FROM audit_events`),
        events: count(raw, `SELECT COUNT(*) AS n FROM receipt_events`),
      };

      const missing = await c.run(db, undefined);
      expect(missing.kind).toBe('refused');
      expect(missing.status).toBe(403);
      expect(missing.code).toBe('forbidden');

      // A real identity, a member elsewhere (ws-demo-b's owner is not), not here.
      const stranger = await c.run(db, STRANGER);
      expect(stranger.kind).toBe('refused');
      expect(stranger.status).toBe(403);

      // The operator loses the membership after authorization would have passed.
      raw.prepare(`UPDATE memberships SET revoked_at = '2026-10-29T00:00:00.000Z' WHERE id = 'mb-demo-op-a'`).run();
      const revoked = await c.run(db, OPERATOR);
      expect(revoked.kind).toBe('refused');
      expect(revoked.status).toBe(403);

      // Nothing was recorded against anyone.
      expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events`)).toBe(before.audit);
      expect(count(raw, `SELECT COUNT(*) AS n FROM receipt_events`)).toBe(before.events);
    });
  }

  it('records the write against the caller, not the first owner it can find', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const result = await createReceipt(db, {
      workspaceId: WS,
      orderId: 'ord-demo-01',
      amountVnd: 1_000_000,
      reference: 'VCB-OP',
      actorId: OPERATOR,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const event = raw
      .prepare(`SELECT actor_id FROM receipt_events WHERE receipt_id = ? AND kind = 'create'`)
      .get(result.value.id) as { actor_id: string };
    expect(event.actor_id).toBe(OPERATOR);
  });
});

describe('accepting a quote is one transaction', () => {
  it('writes the revision, the order and the audit row together, with the server deposit rate', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const accepted = await acceptRevision(db, { workspaceId: WS, revisionId: 'qr-demo-02-r1', actorId: OPERATOR });
    expect(accepted.kind).toBe('ok');
    if (accepted.kind !== 'ok') return;
    expect(accepted.value.created).toBe(true);
    expect(accepted.value.order.total_vnd).toBe(9_500_000);
    expect(accepted.value.order.deposit_required_vnd).toBe(2_850_000); // 30% of 9.5M
    expect(accepted.value.order.pilot_credit_applied_vnd).toBe(0);
    expect(accepted.value.order.status).toBe('pending_deposit');
    expect(DEFAULT_DEPOSIT_RATE_BPS).toBe(3000);

    const revision = await readRevision(db, WS, 'qr-demo-02-r1');
    expect(revision?.status).toBe('accepted');
    const audit = raw
      .prepare(`SELECT actor_id, detail FROM audit_events WHERE action = 'quote.accepted' AND subject_id = 'qr-demo-02-r1'`)
      .all() as { actor_id: string; detail: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe(OPERATOR);
    expect(JSON.parse(audit[0]!.detail).deposit_rate_bps).toBe(3000);
  });

  it('leaves the revision issued and no order when the order insert fails', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    // Another chain already holds the order code this acceptance would mint.
    raw
      .prepare(
        `INSERT INTO orders (id, workspace_id, quote_chain_id, accepted_revision_id, customer_id,
           order_code, total_vnd, deposit_required_vnd, pilot_credit_applied_vnd,
           collected_vnd, refund_owed_vnd, status, note, created_at, updated_at)
         VALUES ('ord-clash', 'ws-demo-a', 'qc-demo-03', 'qr-demo-03-r1', 'cu-a-04',
           'ORD-BG-2026-002-1', 1000, 300, 0, 0, 0, 'pending_deposit', NULL,
           '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z')`,
      )
      .run();

    await expect(
      acceptRevision(db, { workspaceId: WS, revisionId: 'qr-demo-02-r1', actorId: OPERATOR }),
    ).rejects.toThrow(/UNIQUE/);

    const revision = await readRevision(db, WS, 'qr-demo-02-r1');
    expect(revision?.status).toBe('issued');
    expect(revision?.accepted_at).toBeNull();
    expect(count(raw, `SELECT COUNT(*) AS n FROM orders WHERE quote_chain_id = 'qc-demo-02'`)).toBe(0);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'quote.accepted' AND subject_id = 'qr-demo-02-r1'`)).toBe(0);
  });

  it('answers two interleaved accepts of the same revision with one order', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const [a, b] = await Promise.all([
      acceptRevision(db, { workspaceId: WS, revisionId: 'qr-demo-02-r1', actorId: OPERATOR }),
      acceptRevision(db, { workspaceId: WS, revisionId: 'qr-demo-02-r1', actorId: OWNER }),
    ]);
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    if (a.kind !== 'ok' || b.kind !== 'ok') return;
    expect(a.value.order.id).toBe(b.value.order.id);
    expect([a.value.created, b.value.created].filter(Boolean)).toHaveLength(1);
    expect(count(raw, `SELECT COUNT(*) AS n FROM orders WHERE quote_chain_id = 'qc-demo-02'`)).toBe(1);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'quote.accepted' AND subject_id = 'qr-demo-02-r1'`)).toBe(1);
  });

  it('refuses a stale accept once the revision moved under it', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const stale = racing(db, () => {
      // The revision was superseded between the read and the write.
      void db.prepare(`UPDATE quote_revisions SET status = 'superseded' WHERE id = 'qr-demo-02-r1'`).bind().run();
    });
    const result = await acceptRevision(stale, { workspaceId: WS, revisionId: 'qr-demo-02-r1', actorId: OPERATOR });
    expect(result.kind).toBe('refused');
    expect(result.status).toBe(409);
    expect(result.code).toBe('invalid_state');
  });

  it('ignores a client-supplied deposit rate and pilot credit at the route', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const response = await handleAcceptRevision(actorRequest(db, OPERATOR, 'workspace_operator'), {
      revision_id: 'qr-demo-02-r1',
      deposit_rate_bps: 0,
      pilot_credit_vnd: 9_500_000,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { order: { deposit_required_vnd: number; pilot_credit_applied_vnd: number; status: string } };
    expect(body.order.deposit_required_vnd).toBe(2_850_000);
    expect(body.order.pilot_credit_applied_vnd).toBe(0);
    expect(body.order.status).toBe('pending_deposit');
  });

  it('strictly walls off OPC pilot credits from nursery order math (accept, receipt, deposit, delivery)', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });

    // Programmatic callers attempting to inject non-zero pilotCreditVnd into a nursery order are refused.
    const badAccept = await acceptRevision(db, {
      workspaceId: WS,
      revisionId: 'qr-demo-02-r1',
      pilotCreditVnd: 1_000_000,
      actorId: OPERATOR,
    });
    expect(badAccept.kind).toBe('refused');
    expect(badAccept.status).toBe(400);

    const okAccept = await acceptRevision(db, {
      workspaceId: WS,
      revisionId: 'qr-demo-02-r1',
      actorId: OPERATOR,
    });
    expect(okAccept.kind).toBe('ok');
    if (okAccept.kind !== 'ok') return;
    const orderId = okAccept.value.order.id;

    // Even if a legacy row in `orders` had a non-zero `pilot_credit_applied_vnd`, nursery deposit/receipt/delivery
    // checks depend solely on confirmed nursery `collected_vnd` and `total_vnd`.
    raw.prepare(`UPDATE orders SET pilot_credit_applied_vnd = 2_850_000 WHERE id = ?`).run(orderId);

    const prematureDelivery = await createDelivery(db, {
      workspaceId: WS,
      orderId,
      scheduledDate: '2026-11-20',
      deliveryAddress: 'Sa Đéc',
      actorId: OPERATOR,
    });
    expect(prematureDelivery.kind).toBe('refused');
    expect(prematureDelivery.status).toBe(409);

    // Full 9_500_000 VND nursery receivable remains collectable because OPC credit never offsets nursery orders.
    const fullReceipt = await createReceipt(db, {
      workspaceId: WS,
      orderId,
      amountVnd: 9_500_000,
      reference: 'VCB-FULL-9500K',
      actorId: OPERATOR,
    });
    expect(fullReceipt.kind).toBe('ok');
  });
});

describe('a receipt never exceeds what the order still owes', () => {
  it('refuses to record more than the remaining balance, with a code', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    // ord-demo-01: total 15.000.000, collected 4.500.000 → 10.500.000 remaining.
    const over = await createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 10_500_001, actorId: OPERATOR });
    expect(over.kind).toBe('refused');
    expect(over.status).toBe(409);
    expect(over.code).toBe('invalid_state');
    const exact = await createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 10_500_000, actorId: OPERATOR });
    expect(exact.kind).toBe('ok');
    expect(count(raw, `SELECT COUNT(*) AS n FROM receipts WHERE order_id = 'ord-demo-01' AND status = 'pending'`)).toBe(1);

    const response = await handleCreateReceipt(actorRequest(db, OPERATOR, 'workspace_operator'), {
      order_id: 'ord-demo-01',
      amount_vnd: 1,
      reference: 'VCB-X',
    });
    // The exact receipt is still pending, so the order still owes 10.5M; a
    // second pending claim of 1₫ is within it.
    expect(response.status).toBe(201);
  });

  it('refuses at confirmation when an earlier confirmation used up the balance', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const a = await createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 5_000_000, actorId: OPERATOR });
    const b = await createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 6_000_000, actorId: OPERATOR });
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('setup');

    const first = await confirmReceipt(db, { workspaceId: WS, receiptId: a.value.id, actorId: OWNER });
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.order.collected_vnd).toBe(9_500_000);

    const second = await confirmReceipt(db, { workspaceId: WS, receiptId: b.value.id, actorId: OWNER });
    expect(second.kind).toBe('refused');
    expect(second.status).toBe(409);
    expect(second.code).toBe('invalid_state');
    expect(second.message).toMatch(/vượt quá tổng giá trị/);

    const receipt = raw.prepare(`SELECT status FROM receipts WHERE id = ?`).get(b.value.id) as { status: string };
    expect(receipt.status).toBe('pending');
    const order = await readOrder(db, WS, 'ord-demo-01');
    expect(order?.collected_vnd).toBe(9_500_000);
    expect(count(raw, `SELECT COUNT(*) AS n FROM receipt_events WHERE receipt_id = ? AND kind = 'confirm'`, b.value.id)).toBe(0);
  });

  it('lets exactly one of two interleaved confirmations of the same receipt through', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const created = await createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 5_000_000, actorId: OPERATOR });
    if (created.kind !== 'ok') throw new Error('setup');

    const [x, y] = await Promise.all([
      confirmReceipt(db, { workspaceId: WS, receiptId: created.value.id, actorId: OWNER }),
      confirmReceipt(db, { workspaceId: WS, receiptId: created.value.id, actorId: 'id-demo-admin' }),
    ]);
    const outcomes = [x, y].map((o) => o.kind).sort();
    expect(outcomes).toEqual(['ok', 'refused']);
    const loser = [x, y].find((o) => o.kind === 'refused')!;
    expect(loser.status).toBe(409);

    const order = await readOrder(db, WS, 'ord-demo-01');
    expect(order?.collected_vnd).toBe(9_500_000); // credited once
    expect(count(raw, `SELECT COUNT(*) AS n FROM receipt_events WHERE receipt_id = ? AND kind = 'confirm'`, created.value.id)).toBe(1);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'receipt.confirmed' AND subject_id = ?`, created.value.id)).toBe(1);
  });

  it('keeps collected within the total when two receipts race past the balance', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const a = await createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 8_000_000, actorId: OPERATOR });
    const b = await createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 8_000_000, actorId: OPERATOR });
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('setup');

    const [x, y] = await Promise.all([
      confirmReceipt(db, { workspaceId: WS, receiptId: a.value.id, actorId: OWNER }),
      confirmReceipt(db, { workspaceId: WS, receiptId: b.value.id, actorId: OWNER }),
    ]);
    expect([x, y].map((o) => o.kind).sort()).toEqual(['ok', 'refused']);
    const order = await readOrder(db, WS, 'ord-demo-01');
    expect(order?.collected_vnd).toBe(12_500_000);
    expect(count(raw, `SELECT COUNT(*) AS n FROM receipts WHERE order_id = 'ord-demo-01' AND status = 'confirmed'`)).toBe(2);
  });

  it('does not confirm a receipt whose order was credited by someone else in between', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const created = await createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 6_000_000, actorId: OPERATOR });
    if (created.kind !== 'ok') throw new Error('setup');
    const racy = racing(db, () => {
      raw.prepare(`UPDATE orders SET collected_vnd = 10_000_000 WHERE id = 'ord-demo-01'`).run();
    });
    const result = await confirmReceipt(racy, { workspaceId: WS, receiptId: created.value.id, actorId: OWNER });
    expect(result.kind).toBe('refused');
    expect(result.status).toBe(409);
    const receipt = raw.prepare(`SELECT status, confirmed_by FROM receipts WHERE id = ?`).get(created.value.id) as {
      status: string;
      confirmed_by: string | null;
    };
    expect(receipt.status).toBe('pending');
    expect(receipt.confirmed_by).toBeNull();
    expect(count(raw, `SELECT COUNT(*) AS n FROM receipt_events WHERE receipt_id = ? AND kind = 'confirm'`, created.value.id)).toBe(0);
  });

  it('moves a pending_deposit order to deposit_confirmed only when the deposit is covered', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const { order } = await acceptedOrder(db, 'BG-DEP-01'); // total 10M, deposit 3M
    expect(order.status).toBe('pending_deposit');

    const part = await createReceipt(db, { workspaceId: WS, orderId: order.id, amountVnd: 2_999_999, actorId: OPERATOR });
    if (part.kind !== 'ok') throw new Error('setup');
    const partConfirmed = await confirmReceipt(db, { workspaceId: WS, receiptId: part.value.id, actorId: OWNER });
    expect(partConfirmed.kind).toBe('ok');
    if (partConfirmed.kind !== 'ok') return;
    expect(partConfirmed.value.order.status).toBe('pending_deposit');

    const rest = await createReceipt(db, { workspaceId: WS, orderId: order.id, amountVnd: 1, actorId: OPERATOR });
    if (rest.kind !== 'ok') throw new Error('setup');
    const restConfirmed = await confirmReceipt(db, { workspaceId: WS, receiptId: rest.value.id, actorId: OWNER });
    expect(restConfirmed.kind).toBe('ok');
    if (restConfirmed.kind !== 'ok') return;
    expect(restConfirmed.value.order.status).toBe('deposit_confirmed');
    expect(restConfirmed.value.order.collected_vnd).toBe(3_000_000);
  });

  it('reverses a receipt and debits the order in the same transaction, never below zero', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const reversed = await reverseReceipt(db, {
      workspaceId: WS,
      receiptId: 'rc-demo-01',
      reason: 'Ngân hàng hoàn lại lệnh chuyển',
      actorId: OWNER,
    });
    expect(reversed.kind).toBe('ok');
    if (reversed.kind !== 'ok') return;
    expect(reversed.value.receipt.status).toBe('reversed');
    expect(reversed.value.receipt.reversed_by).toBe(OWNER);
    expect(reversed.value.order.collected_vnd).toBe(0);
    expect(reversed.value.refundOwedVnd).toBe(0);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'receipt.reversed' AND subject_id = 'rc-demo-01'`)).toBe(1);

    const again = await reverseReceipt(db, { workspaceId: WS, receiptId: 'rc-demo-01', reason: 'Lần nữa', actorId: OWNER });
    expect(again.kind).toBe('refused');
    expect(again.status).toBe(409);
    expect(again.code).toBe('invalid_state');
  });
});

describe('a delivery under deposit is an owner exception, decided in SQL', () => {
  it('refuses a plain schedule under deposit and records the owner override with its own audit row', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const { order } = await acceptedOrder(db, 'BG-DLV-01');

    const plain = await handleCreateDelivery(actorRequest(db, OPERATOR, 'workspace_operator'), {
      order_id: order.id,
      scheduled_date: '2026-11-02',
      delivery_address: 'Giao tại vườn',
    });
    expect(plain.status).toBe(409);
    expect(((await plain.json()) as { code: string }).code).toBe('invalid_state');

    // The operator asking for the override through the create route is refused
    // by the same permission table as the override route.
    const operatorOverride = await handleCreateDelivery(actorRequest(db, OPERATOR, 'workspace_operator'), {
      order_id: order.id,
      scheduled_date: '2026-11-02',
      delivery_address: 'Giao tại vườn',
      override_under_deposit: true,
      override_reason: 'Khách quen',
    });
    expect(operatorOverride.status).toBe(403);
    expect(((await operatorOverride.json()) as { code: string }).code).toBe('forbidden');
    expect(count(raw, `SELECT COUNT(*) AS n FROM deliveries WHERE order_id = ?`, order.id)).toBe(0);

    const noReason = await handleCreateDelivery(actorRequest(db, OWNER, 'workspace_owner'), {
      order_id: order.id,
      scheduled_date: '2026-11-02',
      delivery_address: 'Giao tại vườn',
      override_under_deposit: true,
    });
    expect(noReason.status).toBe(400);

    const ownerOverride = await handleCreateDelivery(actorRequest(db, OWNER, 'workspace_owner'), {
      order_id: order.id,
      scheduled_date: '2026-11-02',
      delivery_address: 'Giao tại vườn',
      override_under_deposit: true,
      override_reason: 'Khách quen 5 năm, trả đủ khi nhận',
    });
    expect(ownerOverride.status).toBe(201);
    const body = (await ownerOverride.json()) as { delivery: { id: string; under_deposit_override: number; override_by: string } };
    expect(body.delivery.under_deposit_override).toBe(1);
    expect(body.delivery.override_by).toBe(OWNER);
    const audit = raw
      .prepare(`SELECT action, actor_id FROM audit_events WHERE subject_type = 'delivery' AND subject_id = ? ORDER BY action`)
      .all(body.delivery.id) as { action: string; actor_id: string }[];
    expect(audit.map((a) => a.action)).toEqual(['delivery.scheduled', 'delivery.under_deposit_override']);
    expect(audit.every((a) => a.actor_id === OWNER)).toBe(true);
  });

  it('refuses the schedule when the deposit is reversed between the read and the write', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const { order } = await acceptedOrder(db, 'BG-DLV-02'); // deposit 3M
    const receipt = await createReceipt(db, { workspaceId: WS, orderId: order.id, amountVnd: 3_000_000, actorId: OPERATOR });
    if (receipt.kind !== 'ok') throw new Error('setup');
    const confirmed = await confirmReceipt(db, { workspaceId: WS, receiptId: receipt.value.id, actorId: OWNER });
    expect(confirmed.kind).toBe('ok');

    const racy = racing(db, () => {
      raw.prepare(`UPDATE orders SET collected_vnd = 0 WHERE id = ?`).run(order.id);
    });
    const result = await createDelivery(racy, { workspaceId: WS, orderId: order.id, scheduledDate: '2026-11-03', actorId: OPERATOR });
    expect(result.kind).toBe('refused');
    expect(result.status).toBe(409);
    expect(result.code).toBe('invalid_state');
    expect(count(raw, `SELECT COUNT(*) AS n FROM deliveries WHERE order_id = ?`, order.id)).toBe(0);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'delivery.scheduled' AND detail LIKE ?`, `%${order.id}%`)).toBe(0);
  });

  it('schedules a covered order once, and answers a second schedule with a conflict', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const { order } = await acceptedOrder(db, 'BG-DLV-03');
    const receipt = await createReceipt(db, { workspaceId: WS, orderId: order.id, amountVnd: 3_000_000, actorId: OPERATOR });
    if (receipt.kind !== 'ok') throw new Error('setup');
    await confirmReceipt(db, { workspaceId: WS, receiptId: receipt.value.id, actorId: OWNER });

    const [a, b] = await Promise.all([
      createDelivery(db, { workspaceId: WS, orderId: order.id, scheduledDate: '2026-11-03', actorId: OPERATOR }),
      createDelivery(db, { workspaceId: WS, orderId: order.id, scheduledDate: '2026-11-04', actorId: OPERATOR }),
    ]);
    expect([a, b].map((o) => o.kind).sort()).toEqual(['ok', 'refused']);
    const loser = [a, b].find((o) => o.kind === 'refused')!;
    expect(loser.status).toBe(409);
    expect(loser.code).toBe('conflict');
    expect(count(raw, `SELECT COUNT(*) AS n FROM deliveries WHERE order_id = ?`, order.id)).toBe(1);
  });

  it('walks the delivery state machine, marks the order delivered in the same batch, and audits', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    // dlv-demo-01 is scheduled for ord-demo-01, whose deposit is covered.
    const backwards = await updateDeliveryStatus(db, { workspaceId: WS, deliveryId: 'dlv-demo-01', status: 'scheduled', actorId: OPERATOR });
    expect(backwards.kind).toBe('ok'); // same status is a no-op

    const out = await updateDeliveryStatus(db, { workspaceId: WS, deliveryId: 'dlv-demo-01', status: 'in_transit', actorId: OPERATOR });
    expect(out.kind).toBe('ok');
    const undo = await updateDeliveryStatus(db, { workspaceId: WS, deliveryId: 'dlv-demo-01', status: 'scheduled', actorId: OPERATOR });
    expect(undo.kind).toBe('refused');
    expect(undo.code).toBe('invalid_state');

    const done = await updateDeliveryStatus(db, { workspaceId: WS, deliveryId: 'dlv-demo-01', status: 'delivered', actorId: OPERATOR });
    expect(done.kind).toBe('ok');
    const order = await readOrder(db, WS, 'ord-demo-01');
    expect(order?.status).toBe('delivered');
    const audit = raw
      .prepare(`SELECT detail FROM audit_events WHERE action = 'delivery.status_changed' AND subject_id = 'dlv-demo-01' ORDER BY created_at`)
      .all() as { detail: string }[];
    expect(audit.map((a) => JSON.parse(a.detail).to)).toEqual(['in_transit', 'delivered']);

    const after = await updateDeliveryStatus(db, { workspaceId: WS, deliveryId: 'dlv-demo-01', status: 'cancelled', actorId: OPERATOR });
    expect(after.kind).toBe('refused');
  });
});

describe('order status changes are one transaction with their audit row', () => {
  it('cancels with the refund owed taken from the live collected amount', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const racy = racing(db, () => {
      // A confirmation lands after the cancel read the order.
      raw.prepare(`UPDATE orders SET collected_vnd = 7_000_000 WHERE id = 'ord-demo-01'`).run();
    });
    const cancelled = await cancelOrder(racy, { workspaceId: WS, orderId: 'ord-demo-01', reason: 'Khách đổi ý', actorId: OWNER });
    expect(cancelled.kind).toBe('ok');
    if (cancelled.kind !== 'ok') return;
    expect(cancelled.value.status).toBe('cancelled');
    expect(cancelled.value.refund_owed_vnd).toBe(7_000_000);
    const audit = raw
      .prepare(`SELECT actor_id, detail FROM audit_events WHERE action = 'order.cancelled' AND subject_id = 'ord-demo-01'`)
      .all() as { actor_id: string; detail: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe(OWNER);
    expect(JSON.parse(audit[0]!.detail)).toEqual({ reason: 'Khách đổi ý', refund_owed_vnd: 7_000_000 });

    const again = await cancelOrder(db, { workspaceId: WS, orderId: 'ord-demo-01', reason: 'Lại', actorId: OWNER });
    expect(again.kind).toBe('ok'); // idempotent
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.cancelled' AND subject_id = 'ord-demo-01'`)).toBe(1);

    const noReceipts = await createReceipt(db, { workspaceId: WS, orderId: 'ord-demo-01', amountVnd: 1, actorId: OPERATOR });
    expect(noReceipts.kind).toBe('refused');
    expect(noReceipts.code).toBe('invalid_state');
  });

  it('refuses an illegal transition and a stale one, and audits a legal one once', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const illegal = await transitionOrder(db, { workspaceId: WS, orderId: 'ord-demo-01', to: 'pending_deposit', actorId: OPERATOR });
    expect(illegal.kind).toBe('refused');
    expect(illegal.code).toBe('invalid_state');

    const [a, b] = await Promise.all([
      transitionOrder(db, { workspaceId: WS, orderId: 'ord-demo-01', to: 'delivered', actorId: OPERATOR }),
      transitionOrder(db, { workspaceId: WS, orderId: 'ord-demo-01', to: 'cancelled', actorId: OWNER }),
    ]);
    expect([a, b].map((o) => o.kind).sort()).toEqual(['ok', 'refused']);
    expect(count(raw, `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.status_changed' AND subject_id = 'ord-demo-01'`)).toBe(1);
  });

  it('prevents two 80,000 VND pending receipts from both confirming against a 100,000 VND remaining balance', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const prod = await createProduct(db, {
      workspaceId: WS,
      name: 'Cúc mâm xôi mini',
      species: 'Chrysanthemum',
      unit: 'chậu',
      priceVnd: 100_000,
    });
    if (prod.kind !== 'ok') throw new Error('product setup');
    const created = await createQuoteChain(db, {
      workspaceId: WS,
      customerId: 'cu-a-01',
      reference: 'BG-100K-80K',
      lines: [{ product_id: prod.value.id, quantity: 1 }],
    });
    if (created.kind !== 'ok') throw new Error('chain setup');
    const revId = created.value.revisions[0]!.id;
    await issueRevision(db, { workspaceId: WS, revisionId: revId });
    const accepted = await acceptRevision(db, { workspaceId: WS, revisionId: revId, actorId: OPERATOR });
    if (accepted.kind !== 'ok') throw new Error('accept setup');

    const r1 = await createReceipt(db, { workspaceId: WS, orderId: accepted.value.id, amountVnd: 80_000, actorId: OPERATOR });
    const r2 = await createReceipt(db, { workspaceId: WS, orderId: accepted.value.id, amountVnd: 80_000, actorId: OPERATOR });
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    if (r1.kind !== 'ok' || r2.kind !== 'ok') return;

    const [c1, c2] = await Promise.all([
      confirmReceipt(db, { workspaceId: WS, receiptId: r1.value.id, actorId: OWNER }),
      confirmReceipt(db, { workspaceId: WS, receiptId: r2.value.id, actorId: OWNER }),
    ]);
    expect([c1, c2].map((o) => o.kind).sort()).toEqual(['ok', 'refused']);
    const loser = [c1, c2].find((o) => o.kind === 'refused')!;
    expect(loser.status).toBe(409);

    const liveOrder = await readOrder(db, WS, accepted.value.id);
    expect(liveOrder?.collected_vnd).toBe(80_000);
  });

  it('wires actorId through handleTransitionOrder, reverts deposit_confirmed on reversal, escapes HTML in printable quotes, and validates follow-up assignees', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const transitionRes = await handleTransitionOrder(
      { workspaceId: WS, db, actorId: OPERATOR, role: 'workspace_operator' },
      { order_id: 'ord-demo-01', to: 'delivered' },
    );
    expect(transitionRes.status).toBe(200);
    const transitionBody = (await transitionRes.json()) as { order: { status: string } };
    expect(transitionBody.order.status).toBe('delivered');

    const { order: freshOrder } = await acceptedOrder(db, 'BG-REV-STATUS');
    const depRc = await createReceipt(db, { workspaceId: WS, orderId: freshOrder.id, amountVnd: freshOrder.deposit_required_vnd, actorId: OPERATOR });
    if (depRc.kind !== 'ok') throw new Error('receipt setup');
    const depConfirmed = await confirmReceipt(db, { workspaceId: WS, receiptId: depRc.value.id, actorId: OWNER });
    expect(depConfirmed.kind).toBe('ok');
    if (depConfirmed.kind !== 'ok') return;
    expect(depConfirmed.value.order.status).toBe('deposit_confirmed');
    const depReversed = await reverseReceipt(db, { workspaceId: WS, receiptId: depRc.value.id, reason: 'Hoàn cọc kiểm thử', actorId: OWNER });
    expect(depReversed.kind).toBe('ok');
    if (depReversed.kind !== 'ok') return;
    expect(depReversed.value.order.status).toBe('pending_deposit');
    expect(depReversed.value.order.collected_vnd).toBe(0);

    // Operator cannot bypass deposit confirmation via /api/orders/transition when deposit is uncovered.
    const bypassAttempt = await handleTransitionOrder(
      { workspaceId: WS, db, actorId: OPERATOR, role: 'workspace_operator' },
      { order_id: freshOrder.id, to: 'deposit_confirmed' },
    );
    expect(bypassAttempt.status).toBe(409);

    const badAssignee = await createFollowUpTask(db, {
      workspaceId: WS,
      customerId: 'cu-a-01',
      dueDate: '2026-12-01',
      taskKind: 'quality_check',
      assignedTo: 'non-existent-identity',
    });
    expect(badAssignee.kind).toBe('refused');
    if (badAssignee.kind === 'refused') expect(badAssignee.status).toBe(400);

    const xssCustomer = await createCustomer(db, {
      workspaceId: WS,
      name: '<script>window.__xss=1</script>Khách A',
      contactName: '<img src=x onerror=alert(1)>',
      phone: '0909"><b>1</b>',
    });
    if (xssCustomer.kind !== 'ok') throw new Error('customer setup');
    const xssProd = await createProduct(db, {
      workspaceId: WS,
      name: 'Hoa giấy <img src=x onerror=alert(2)>',
      unit: 'chậu',
      priceVnd: 150_000,
    });
    if (xssProd.kind !== 'ok') throw new Error('product setup');
    const xssChain = await createQuoteChain(db, {
      workspaceId: WS,
      customerId: xssCustomer.value.id,
      reference: 'BG-<XSS>',
      lines: [{ product_id: xssProd.value.id, quantity: 1, note: '<b>ghi chú</b>' }],
      conditionsNote: '<svg onload=alert(1)>',
    });
    if (xssChain.kind !== 'ok') throw new Error('chain setup');
    const htmlRes = await getPrintableQuoteHtml(db, {
      workspaceId: WS,
      revisionId: xssChain.value.revisions[0]!.id,
      demo: true,
    });
    expect(htmlRes.kind).toBe('ok');
    if (htmlRes.kind !== 'ok') return;
    expect(htmlRes.value).not.toContain('<script>');
    expect(htmlRes.value).not.toContain('<svg onload');
    expect(htmlRes.value).toContain('&lt;script&gt;window.__xss=1&lt;/script&gt;');
    expect(htmlRes.value).toContain('@page { size: A4 portrait;');
    expect(htmlRes.value).toContain('@media print');

    // Two distinct workspaces accepting the same quote reference (e.g. BG-SHARED-001 v1)
    // both mint ORD-BG-SHARED-001-1 without cross-tenant UNIQUE collision.
    const wsAQuote = await issuedQuote(db, 'BG-SHARED-001');
    const wsACreated = await acceptRevision(db, {
      workspaceId: WS,
      revisionId: wsAQuote.revisionId,
      actorId: OWNER,
    });
    expect(wsACreated.kind).toBe('ok');

    const custB = await createCustomer(db, { workspaceId: 'ws-demo-b', name: 'Khách B' });
    if (custB.kind !== 'ok') throw new Error('custB setup');
    const chainB = await createQuoteChain(db, {
      workspaceId: 'ws-demo-b',
      customerId: custB.value.id,
      reference: 'BG-SHARED-001',
      lines: [{ product_name: 'Cúc mâm xôi', quantity: 5, unit: 'chậu', unit_price_vnd: 120_000 }],
    });
    if (chainB.kind !== 'ok') throw new Error('chainB setup');
    const revBId = chainB.value.revisions[0]!.id;
    await issueRevision(db, { workspaceId: 'ws-demo-b', revisionId: revBId });
    const wsBCreated = await acceptRevision(db, {
      workspaceId: 'ws-demo-b',
      revisionId: revBId,
      actorId: OWNER,
    });
    expect(wsBCreated.kind).toBe('ok');
    if (wsACreated.kind === 'ok' && wsBCreated.kind === 'ok') {
      expect(wsACreated.value.order_code).toBe('ORD-BG-SHARED-001-1');
      expect(wsBCreated.value.order_code).toBe('ORD-BG-SHARED-001-1');
    }
  });
});

describe('pending receipt voiding, catalog/customer optimistic updates, quote snapshots, and Vietnamese search', () => {
  it('voids a losing or mistaken pending receipt, clears TodaySummary.deposits_to_confirm, leaves collected_vnd untouched, and serializes against confirmReceipt', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });
    const hundredKProd = await createProduct(db, {
      workspaceId: WS,
      name: 'Cúc tiểu chậu thử void',
      unit: 'chậu',
      priceVnd: 100_000,
    });
    if (hundredKProd.kind !== 'ok') throw new Error('setup failed');

    const chain = await createQuoteChain(db, {
      workspaceId: WS,
      customerId: 'cu-a-01',
      reference: 'BG-VOID-100K',
      lines: [{ product_id: hundredKProd.value.id, quantity: 1 }],
    });
    if (chain.kind !== 'ok') throw new Error('setup failed');
    const revId = chain.value.revisions[0]!.id;
    await issueRevision(db, { workspaceId: WS, revisionId: revId });
    const accepted = await acceptRevision(db, { workspaceId: WS, revisionId: revId, actorId: OPERATOR });
    if (accepted.kind !== 'ok') throw new Error('setup failed');

    const beforeToday = await readTodaySummary(db, WS);
    const baselinePendingCount = beforeToday.deposits_to_confirm;

    const r1 = await createReceipt(db, { workspaceId: WS, orderId: accepted.value.id, amountVnd: 80_000, actorId: OPERATOR });
    const r2 = await createReceipt(db, { workspaceId: WS, orderId: accepted.value.id, amountVnd: 80_000, actorId: OPERATOR });
    if (r1.kind !== 'ok' || r2.kind !== 'ok') throw new Error('receipt setup');

    const midToday = await readTodaySummary(db, WS);
    expect(midToday.deposits_to_confirm).toBe(baselinePendingCount + 2);

    // Confirm r1 (80k); r2 (80k) loses the balance check (20k remaining) and stays pending.
    const c1 = await confirmReceipt(db, { workspaceId: WS, receiptId: r1.value.id, actorId: OWNER });
    expect(c1.kind).toBe('ok');
    const c2 = await confirmReceipt(db, { workspaceId: WS, receiptId: r2.value.id, actorId: OWNER });
    expect(c2.kind).toBe('refused');
    expect((await readTodaySummary(db, WS)).deposits_to_confirm).toBe(baselinePendingCount + 1);

    // Blank reason is refused with 400 validation.
    const blankRes = await handleVoidReceipt(
      { workspaceId: WS, db, actorId: OPERATOR, role: 'workspace_operator' },
      { receipt_id: r2.value.id, reason: '   ' },
    );
    expect(blankRes.status).toBe(400);

    // Confirmed receipt cannot be voided (must use reverseReceipt).
    const voidConfirmed = await voidReceipt(db, {
      workspaceId: WS,
      receiptId: r1.value.id,
      reason: 'Thử hủy nhầm phiếu đã thu',
      actorId: OPERATOR,
    });
    expect(voidConfirmed.kind).toBe('refused');
    if (voidConfirmed.kind === 'refused') expect(voidConfirmed.status).toBe(409);

    // Operator voids the losing pending receipt r2 cleanly via HTTP handler.
    const voidRes = await handleVoidReceipt(
      { workspaceId: WS, db, actorId: OPERATOR, role: 'workspace_operator' },
      { receipt_id: r2.value.id, reason: 'Khách ghi trùng 2 phiếu chờ, hủy phiếu thừa' },
    );
    expect(voidRes.status).toBe(200);
    const voidBody = (await voidRes.json()) as { receipt: { status: string; void_reason: string; voided_by: string } };
    expect(voidBody.receipt.status).toBe('voided');
    expect(voidBody.receipt.void_reason).toBe('Khách ghi trùng 2 phiếu chờ, hủy phiếu thừa');
    expect(voidBody.receipt.voided_by).toBe(OPERATOR);

    // TodaySummary.deposits_to_confirm drops back to baseline; collected_vnd stays 80_000.
    expect((await readTodaySummary(db, WS)).deposits_to_confirm).toBe(baselinePendingCount);
    expect((await readOrder(db, WS, accepted.value.id))?.collected_vnd).toBe(80_000);

    // receipt_events and audit_events record the void atomically.
    const ev = raw
      .prepare(`SELECT kind, actor_id, amount_vnd FROM receipt_events WHERE receipt_id = ?`)
      .all(r2.value.id) as { kind: string; actor_id: string; amount_vnd: number }[];
    expect(ev.map((e) => e.kind)).toEqual(['create', 'void']);
    const audit = raw
      .prepare(`SELECT detail FROM audit_events WHERE action = 'receipt.voided' AND subject_id = ?`)
      .get(r2.value.id) as { detail: string } | undefined;
    expect(audit).toBeDefined();
    expect(JSON.parse(audit!.detail)).toMatchObject({
      order_id: accepted.value.id,
      amount_vnd: 80_000,
      reason: 'Khách ghi trùng 2 phiếu chờ, hủy phiếu thừa',
    });

    // Race between confirmReceipt and voidReceipt on the SAME pending receipt (20k remaining):
    // exactly one wins and the other gets 409 invalid_state.
    const r3 = await createReceipt(db, { workspaceId: WS, orderId: accepted.value.id, amountVnd: 20_000, actorId: OPERATOR });
    if (r3.kind !== 'ok') throw new Error('r3 setup');
    const [raceConfirm, raceVoid] = await Promise.all([
      confirmReceipt(db, { workspaceId: WS, receiptId: r3.value.id, actorId: OWNER }),
      voidReceipt(db, { workspaceId: WS, receiptId: r3.value.id, reason: 'Đua với xác nhận', actorId: OPERATOR }),
    ]);
    expect([raceConfirm.kind, raceVoid.kind].sort()).toEqual(['ok', 'refused']);
    const raceLoser = [raceConfirm, raceVoid].find((x) => x.kind === 'refused')!;
    if (raceLoser.kind === 'refused') expect(raceLoser.status).toBe(409);
  });

  it('enforces optimistic concurrency + RBAC on product/customer updates and freezes customer + product snapshots on issued quote revisions', async () => {
    const { db, raw } = createSqliteD1({ seedDemo: true });

    const cust = await createCustomer(db, {
      workspaceId: WS,
      name: 'Chị Lan Vườn Cũ',
      contactName: 'Chị Lan',
      phone: '0901 111 222',
      address: 'Ấp Tân Khánh, Sa Đéc',
    });
    const prod = await createProduct(db, {
      workspaceId: WS,
      name: 'Cúc Mâm Xôi Vàng Cũ',
      species: 'Chrysanthemum',
      size_class: 'Chậu 30cm',
      grade: 'Loại 1',
      priceVnd: 120_000,
      unit: 'chậu',
    });
    if (cust.kind !== 'ok' || prod.kind !== 'ok') throw new Error('setup failed');

    // Issue v1 quote revision BEFORE editing product or customer.
    const chain = await createQuoteChain(db, {
      workspaceId: WS,
      customerId: cust.value.id,
      reference: 'BG-SNAPSHOT-01',
      lines: [{ product_id: prod.value.id, quantity: 10 }],
    });
    if (chain.kind !== 'ok') throw new Error('chain setup');
    const v1DraftId = chain.value.revisions[0]!.id;
    const issuedV1 = await issueRevision(db, { workspaceId: WS, revisionId: v1DraftId });
    expect(issuedV1.kind).toBe('ok');
    if (issuedV1.kind !== 'ok') return;
    expect(issuedV1.value.customer_snapshot).toEqual({
      name: 'Chị Lan Vườn Cũ',
      contact_name: 'Chị Lan',
      phone: '0901 111 222',
      address: 'Ấp Tân Khánh, Sa Đéc',
    });

    // RBAC via Worker fetch: workspace_operator is refused (403) on /api/products/update,
    // allowed (200) on /api/customers/update.
    type WorkerEnv = Parameters<typeof worker.fetch>[1];
    const operatorEnv: WorkerEnv = {
      DB: db as unknown as WorkerEnv['DB'],
      APP_ENV: 'local',
      DEV_BYPASS_ACCESS: 'demo:sub:operator',
    };
    const dummyCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as Parameters<typeof worker.fetch>[2];
    const opProdRes = await worker.fetch(
      new Request(`http://localhost/api/products/update?workspace_id=${WS}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({
          product_id: prod.value.id,
          name: 'Bị từ chối',
          price_vnd: 999_000,
          unit: 'chậu',
          expected_updated_at: prod.value.updated_at,
        }),
      }),
      operatorEnv,
      dummyCtx,
    );
    expect(opProdRes.status).toBe(403);

    // Owner updates product; concurrent/stale expected_updated_at gets 409 conflict.
    const updProd1 = await handleUpdateProduct(
      { workspaceId: WS, db, actorId: OWNER, role: 'workspace_owner' },
      {
        product_id: prod.value.id,
        name: 'Cúc Mâm Xôi Đại Mới',
        species: 'Chrysanthemum',
        size_class: 'Chậu 40cm',
        grade: 'Đặc biệt',
        price_vnd: 185_000,
        unit: 'chậu',
        expected_updated_at: prod.value.updated_at,
      },
    );
    expect(updProd1.status).toBe(200);

    const staleProd = await updateProduct(db, {
      workspaceId: WS,
      productId: prod.value.id,
      name: 'Ghi đè cũ',
      priceVnd: 130_000,
      unit: 'chậu',
      expectedUpdatedAt: prod.value.updated_at, // stale!
      actorId: OWNER,
    });
    expect(staleProd.kind).toBe('refused');
    if (staleProd.kind === 'refused') expect(staleProd.status).toBe(409);

    // Operator updates customer; stale expected_updated_at gets 409 conflict.
    const updCustRes = await handleUpdateCustomer(
      { workspaceId: WS, db, actorId: OPERATOR, role: 'workspace_operator' },
      {
        customer_id: cust.value.id,
        name: 'Công ty TNHH Hoa Cảnh Mới',
        contact_name: 'Anh Minh',
        phone: '0909 888 777',
        address: 'KCN Cái Tàu Hạ, Đồng Tháp',
        expected_updated_at: cust.value.updated_at,
      },
    );
    expect(updCustRes.status).toBe(200);

    const staleCust = await updateCustomer(db, {
      workspaceId: WS,
      customerId: cust.value.id,
      name: 'Ghi đè khách cũ',
      expectedUpdatedAt: cust.value.updated_at, // stale!
      actorId: OPERATOR,
    });
    expect(staleCust.kind).toBe('refused');
    if (staleCust.kind === 'refused') expect(staleCust.status).toBe(409);

    // Issued v1 MUST retain frozen product price (120_000) AND frozen customer snapshot ("Chị Lan Vườn Cũ")
    // across readRevision, printable HTML, and printable JSON!
    const reloadedV1 = await readRevision(db, WS, v1DraftId);
    const reloadedLines = JSON.parse(reloadedV1!.lines_json) as { product_name: string; unit_price_vnd: number }[];
    expect(reloadedLines[0]?.product_name).toBe('Cúc Mâm Xôi Vàng Cũ');
    expect(reloadedLines[0]?.unit_price_vnd).toBe(120_000);
    expect(reloadedV1?.total_vnd).toBe(1_200_000);

    const htmlV1 = await getPrintableQuoteHtml(db, { workspaceId: WS, revisionId: v1DraftId, demo: false });
    expect(htmlV1.kind).toBe('ok');
    if (htmlV1.kind === 'ok') {
      expect(htmlV1.value).toContain('Chị Lan Vườn Cũ');
      expect(htmlV1.value).toContain('0901 111 222');
      expect(htmlV1.value).toContain('Ấp Tân Khánh, Sa Đéc');
      expect(htmlV1.value).not.toContain('Công ty TNHH Hoa Cảnh Mới');
    }

    const jsonV1Res = await handlePrintableQuote(
      { workspaceId: WS, db, actorId: OPERATOR, role: 'workspace_operator' },
      new URLSearchParams({ revision_id: v1DraftId, format: 'json', demo: '0' }),
    );
    expect(jsonV1Res.status).toBe(200);
    const jsonV1 = (await jsonV1Res.json()) as {
      printable: { customer_name: string; customer_phone: string; customer_address: string };
    };
    expect(jsonV1.printable.customer_name).toBe('Chị Lan Vườn Cũ');
    expect(jsonV1.printable.customer_phone).toBe('0901 111 222');
    expect(jsonV1.printable.customer_address).toBe('Ấp Tân Khánh, Sa Đéc');

    // Revising v1 -> v2 draft picks up live customer on print until issued, then freezes new customer on v2 issue!
    const v2Draft = await reviseIssued(db, { workspaceId: WS, revisionId: v1DraftId });
    expect(v2Draft.kind).toBe('ok');
    if (v2Draft.kind !== 'ok') return;
    expect(v2Draft.value.customer_snapshot).toBeNull();
    const v2Issued = await issueRevision(db, { workspaceId: WS, revisionId: v2Draft.value.id });
    expect(v2Issued.kind).toBe('ok');
    if (v2Issued.kind === 'ok') {
      expect(v2Issued.value.customer_snapshot?.name).toBe('Công ty TNHH Hoa Cảnh Mới');
      expect(v2Issued.value.customer_snapshot?.phone).toBe('0909 888 777');
    }

    // Both audit_events recorded { before, after } diffs.
    const prodAudit = raw
      .prepare(`SELECT detail FROM audit_events WHERE action = 'product.updated' AND subject_id = ?`)
      .get(prod.value.id) as { detail: string } | undefined;
    expect(prodAudit).toBeDefined();
    expect(JSON.parse(prodAudit!.detail).before.price_vnd).toBe(120_000);
    expect(JSON.parse(prodAudit!.detail).after.price_vnd).toBe(185_000);
  });

  it('supports asymmetric Vietnamese diacritic-insensitive search, đ/Đ folding, phone digit matching, and strict tenant isolation', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    await createProduct(db, {
      workspaceId: WS,
      name: 'Cúc đại đóa Đồng Tháp',
      species: 'Chrysanthemum morifolium',
      unit: 'chậu',
      priceVnd: 95_000,
    });
    await createProduct(db, {
      workspaceId: WS,
      name: 'Đá cục trang trí chậu',
      unit: 'bao',
      priceVnd: 45_000,
    });
    await createProduct(db, {
      workspaceId: 'ws-demo-b',
      name: 'Cúc đại đóa Bí Mật Vườn B',
      unit: 'chậu',
      priceVnd: 99_000,
    });

    // Unaccented query matches accented Vietnamese including đ/Đ -> d.
    const unaccentedRes = await handleListProducts(
      { workspaceId: WS, db },
      new URLSearchParams({ q: 'cuc dai doa dong thap' }),
    );
    const unaccentedBody = (await unaccentedRes.json()) as { products: { name: string }[] };
    expect(unaccentedBody.products.map((p) => p.name)).toEqual(['Cúc đại đóa Đồng Tháp']);

    // Accented query 'cúc' matches 'Cúc ...' and does NOT false-match 'Đá cục ...' or leak Workspace B!
    const accentedRes = await handleListProducts(
      { workspaceId: WS, db },
      new URLSearchParams({ q: 'cúc' }),
    );
    const accentedBody = (await accentedRes.json()) as { products: { name: string }[] };
    expect(accentedBody.products.some((p) => p.name === 'Cúc đại đóa Đồng Tháp')).toBe(true);
    expect(accentedBody.products.some((p) => p.name.includes('Đá cục'))).toBe(false);
    expect(accentedBody.products.some((p) => p.name.includes('Bí Mật Vườn B'))).toBe(false);

    // Customer search folds diacritics ('sa dec') AND normalizes phone separators ('0918222333' -> '0918 222 333').
    await createCustomer(db, {
      workspaceId: WS,
      name: 'Nhà Vườn Đình Vũ Sa Đéc',
      phone: '0918 222.333',
      address: 'Tân Quy Đông, Sa Đéc',
    });
    await createCustomer(db, {
      workspaceId: 'ws-demo-b',
      name: 'Nhà Vườn Đình Vũ Khác Tenant',
      phone: '0918 222 333',
    });

    const byNameRes = await handleListCustomers(
      { workspaceId: WS, db },
      new URLSearchParams({ q: 'dinh vu sa dec' }),
    );
    const byNameBody = (await byNameRes.json()) as { customers: { name: string }[] };
    expect(byNameBody.customers.map((c) => c.name)).toEqual(['Nhà Vườn Đình Vũ Sa Đéc']);

    const byPhoneRes = await handleListCustomers(
      { workspaceId: WS, db },
      new URLSearchParams({ q: '0918222333' }),
    );
    const byPhoneBody = (await byPhoneRes.json()) as { customers: { name: string }[] };
    expect(byPhoneBody.customers.map((c) => c.name)).toEqual(['Nhà Vườn Đình Vũ Sa Đéc']);
  });
});

