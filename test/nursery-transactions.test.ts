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
  createQuoteChain,
  createReceipt,
  issueRevision,
  overrideUnderDepositDelivery,
  readOrder,
  readRevision,
  reverseReceipt,
  transitionOrder,
  updateDeliveryStatus,
} from '../src/ops/transactions.ts';
import { DEFAULT_DEPOSIT_RATE_BPS } from '../src/ops/quote-revisions.ts';
import {
  handleAcceptRevision,
  handleCreateDelivery,
  handleCreateReceipt,
  type OpsActorRequest,
} from '../src/ops/routes.ts';
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
});
