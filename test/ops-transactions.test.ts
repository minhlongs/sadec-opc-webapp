import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './sqlite-d1-harness.ts';
import {
  acceptRevisionAndCreateOrder,
  cancelOrder,
  confirmReceipt,
  createCustomer,
  createDelivery,
  createFollowUpTask,
  createProduct,
  createQuoteChain,
  createReceipt,
  getPrintableQuoteHtml,
  getTodaySummary,
  issueRevision,
  listDeliveries,
  listFollowUpTasks,
  listOrders,
  listQuoteChains,
  listReceipts,
  overrideUnderDepositDelivery,
  reverseReceipt,
  reviseIssuedQuote,
  saveDraftRevision,
  transitionOrderStatus,
  updateDeliveryStatus,
  updateFollowUpTask,
} from '../src/ops/transactions.ts';

describe('Phase 2: Ops Transactions & Lifecycle Rules', () => {
  it('creates product, customer, and quote chain with draft revision', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const wsId = 'ws-demo-a';

    const prodRes = await createProduct(db, {
      workspaceId: wsId,
      name: 'Mai Chiếu Thủy Bonsai',
      species: 'Wrightia religiosa',
      size_class: 'Trung',
      grade: 'A',
      priceVnd: 1200000,
      unit: 'chậu',
    });
    expect(prodRes.kind).toBe('ok');
    if (prodRes.kind !== 'ok') return;
    const prod = prodRes.value;

    const custRes = await createCustomer(db, {
      workspaceId: wsId,
      name: 'Đại lý Kiểng Thủ Đức',
      contactName: 'Anh Long',
      phone: '0912345678',
      address: 'Thủ Đức, TP.HCM',
    });
    expect(custRes.kind).toBe('ok');
    if (custRes.kind !== 'ok') return;
    const cust = custRes.value;

    const chainRes = await createQuoteChain(db, {
      workspaceId: wsId,
      customerId: cust.id,
      reference: 'BG-2026-TEST-01',
      lines: [
        {
          product_id: prod.id,
          product_name: prod.name,
          quantity: 5,
          unit: 'chậu',
          unit_price_vnd: prod.price_vnd,
        },
      ],
      discountVnd: 200000,
      feesVnd: 100000,
      validUntil: '2026-11-20',
      conditionsNote: 'Cọc 30% khi chốt',
    });

    expect(chainRes.kind).toBe('ok');
    if (chainRes.kind !== 'ok') return;
    const chain = chainRes.value;
    expect(chain.revisions.length).toBe(1);
    const r1 = chain.revisions[0]!;
    expect(r1.status).toBe('draft');
    expect(r1.subtotal_vnd).toBe(6000000);
    expect(r1.total_vnd).toBe(5900000); // 6.000.000 - 200.000 + 100.000
  });

  it('issues a draft revision, freezing its terms and preventing edit', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const wsId = 'ws-demo-a';

    // Issue qr-demo-03-r1 (seeded as draft)
    const issueRes = await issueRevision(db, {
      workspaceId: wsId,
      revisionId: 'qr-demo-03-r1',
    });
    expect(issueRes.kind).toBe('ok');
    if (issueRes.kind !== 'ok') return;
    expect(issueRes.value.status).toBe('issued');
    expect(issueRes.value.issued_at).not.toBeNull();

    // Trying to save draft to an issued revision is refused
    const editRes = await saveDraftRevision(db, {
      workspaceId: wsId,
      revisionId: 'qr-demo-03-r1',
      lines: [],
    });
    expect(editRes.kind).toBe('refused');
  });

  it('revising an issued quote creates a new revision and supersedes the old one', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const wsId = 'ws-demo-a';

    // qc-demo-02 has qr-demo-02-r1 in 'issued' state
    const revRes = await reviseIssuedQuote(db, {
      workspaceId: wsId,
      chainId: 'qc-demo-02',
    });
    expect(revRes.kind).toBe('ok');
    if (revRes.kind !== 'ok') return;
    expect(revRes.value.revision_number).toBe(2);
    expect(revRes.value.status).toBe('draft');

    const chains = await listQuoteChains(db, wsId);
    const qc2 = chains.find((c) => c.id === 'qc-demo-02');
    expect(qc2).toBeDefined();
    const r1 = qc2?.revisions.find((r) => r.revision_number === 1);
    const r2 = qc2?.revisions.find((r) => r.revision_number === 2);
    expect(r1?.status).toBe('superseded');
    expect(r2?.status).toBe('draft');
  });

  it('accepting a revision creates an order idempotently, and second accept in chain is refused', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const wsId = 'ws-demo-a';

    // Issue qr-demo-02-r1
    const acceptRes1 = await acceptRevisionAndCreateOrder(db, {
      workspaceId: wsId,
      revisionId: 'qr-demo-02-r1',
    });
    expect(acceptRes1.kind).toBe('ok');
    if (acceptRes1.kind !== 'ok') return;
    expect(acceptRes1.value.order.order_code).toMatch(/^ORD-/);
    expect(acceptRes1.value.order.total_vnd).toBe(9500000);
    expect(acceptRes1.value.order.deposit_required_vnd).toBe(2850000); // 30% of 9.5M = 2.85M

    // Idempotent re-acceptance of the same revision returns existing order
    const acceptRes2 = await acceptRevisionAndCreateOrder(db, {
      workspaceId: wsId,
      revisionId: 'qr-demo-02-r1',
    });
    expect(acceptRes2.kind).toBe('ok');
    if (acceptRes2.kind !== 'ok') return;
    expect(acceptRes2.value.order.id).toBe(acceptRes1.value.order.id);

    // Now if qc-demo-01 already has qr-demo-01-r2 accepted, attempting to accept qr-demo-01-r1 is refused
    const acceptConflict = await acceptRevisionAndCreateOrder(db, {
      workspaceId: wsId,
      revisionId: 'qr-demo-01-r1',
    });
    expect(acceptConflict.kind).toBe('refused');
  });

  it('manages deposit receipts, prevents over-payment and duplicate confirmations', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const wsId = 'ws-demo-a';
    const ordId = 'ord-demo-01'; // total 15.000.000, collected 4.500.000

    // Create pending receipt for 5.000.000
    const rcRes = await createReceipt(db, {
      workspaceId: wsId,
      orderId: ordId,
      amountVnd: 5000000,
      reference: 'VCB-DOT2',
      note: 'Thu đợt 2',
    });
    expect(rcRes.kind).toBe('ok');
    if (rcRes.kind !== 'ok') return;
    const rc = rcRes.value;
    expect(rc.status).toBe('pending');

    // Confirm receipt
    const confRes = await confirmReceipt(db, {
      workspaceId: wsId,
      receiptId: rc.id,
      confirmedBy: 'id-demo-owner',
    });
    expect(confRes.kind).toBe('ok');
    if (confRes.kind !== 'ok') return;
    expect(confRes.value.receipt.status).toBe('confirmed');
    expect(confRes.value.order.collected_vnd).toBe(9500000); // 4.5M + 5M

    // Double confirmation is refused
    const confAgain = await confirmReceipt(db, {
      workspaceId: wsId,
      receiptId: rc.id,
      confirmedBy: 'id-demo-owner',
    });
    expect(confAgain.kind).toBe('refused');

    // Attempting to collect more than remaining balance (15.000.000 - 9.500.000 = 5.500.000 max)
    const overRc = await createReceipt(db, {
      workspaceId: wsId,
      orderId: ordId,
      amountVnd: 6000000, // exceeds by 500k
    });
    expect(overRc.kind).toBe('ok');
    if (overRc.kind !== 'ok') return;
    const overConf = await confirmReceipt(db, {
      workspaceId: wsId,
      receiptId: overRc.value.id,
      confirmedBy: 'id-demo-owner',
    });
    expect(overConf.kind).toBe('refused');
    expect(overConf.message).toMatch(/vượt quá tổng giá trị/i);

    // Reverse the 5M receipt
    const revRes = await reverseReceipt(db, {
      workspaceId: wsId,
      receiptId: rc.id,
      reversedBy: 'id-demo-owner',
      reason: 'Khách chuyển nhầm tài khoản',
    });
    expect(revRes.kind).toBe('ok');
    if (revRes.kind !== 'ok') return;
    expect(revRes.value.receipt.status).toBe('reversed');
    expect(revRes.value.order.collected_vnd).toBe(4500000); // reduced back to 4.5M
  });

  it('enforces deposit threshold for deliveries unless owner overrides with reason', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const wsId = 'ws-demo-a';

    // Create an order with zero deposit
    const custRes = await createCustomer(db, {
      workspaceId: wsId,
      name: 'Vườn Mai Đức Hòa',
    });
    if (custRes.kind !== 'ok') throw new Error('cust fail');

    const chainRes = await createQuoteChain(db, {
      workspaceId: wsId,
      customerId: custRes.value.id,
      reference: 'BG-MAI-01',
      lines: [{ product_name: 'Mai vàng', quantity: 10, unit: 'cây', unit_price_vnd: 1000000 }],
    });
    if (chainRes.kind !== 'ok') throw new Error('chain fail');

    const revId = chainRes.value.revisions[0]!.id;
    await issueRevision(db, { workspaceId: wsId, revisionId: revId });
    const ordRes = await acceptRevisionAndCreateOrder(db, { workspaceId: wsId, revisionId: revId });
    if (ordRes.kind !== 'ok') throw new Error('order fail');
    const order = ordRes.value.order;
    expect(order.collected_vnd).toBe(0);
    expect(order.deposit_required_vnd).toBe(3000000);

    // Creating normal delivery without deposit is refused
    const dlvFail = await createDelivery(db, {
      workspaceId: wsId,
      orderId: order.id,
      scheduledDate: '2026-10-28',
    });
    expect(dlvFail.kind).toBe('refused');
    expect(dlvFail.message).toMatch(/chưa thu đủ cọc/i);

    // Owner override with reason permits delivery under-deposit
    const dlvOverride = await overrideUnderDepositDelivery(db, {
      workspaceId: wsId,
      orderId: order.id,
      scheduledDate: '2026-10-28',
      reason: 'Khách quen 5 năm, thanh toán 100% khi nhận hàng tại vườn',
      overrideBy: 'id-demo-owner',
      assignedTo: 'Tài xế Ba Dân',
    });
    expect(dlvOverride.kind).toBe('ok');
    if (dlvOverride.kind !== 'ok') return;
    expect(dlvOverride.value.under_deposit_override).toBe(1);
    expect(dlvOverride.value.override_reason).toMatch(/Khách quen/);

    // Transition delivery status
    const updateRes = await updateDeliveryStatus(db, {
      workspaceId: wsId,
      deliveryId: dlvOverride.value.id,
      status: 'in_transit',
    });
    expect(updateRes.kind).toBe('ok');
    if (updateRes.kind !== 'ok') return;
    expect(updateRes.value.status).toBe('in_transit');
  });

  it('generates printable A4 HTML with DEMO label, terms, and tax disclaimer', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const wsId = 'ws-demo-a';

    const htmlRes = await getPrintableQuoteHtml(db, {
      workspaceId: wsId,
      revisionId: 'qr-demo-01-r2',
      demo: true,
      demoLabel: 'DEMO — DỮ LIỆU THỬ NGHIỆM',
    });

    expect(htmlRes.kind).toBe('ok');
    if (htmlRes.kind !== 'ok') return;
    const html = htmlRes.value;

    expect(html).toContain('BÁO GIÁ — KHÔNG PHẢI HÓA ĐƠN THUẾ');
    expect(html).toContain('DEMO — DỮ LIỆU THỬ NGHIỆM');
    expect(html).toContain('BG-2026-001');
    expect(html).toContain('Phiên bản v2');
    expect(html).toContain('Cau vàng');
    expect(html).toContain('15.000.000');
  });

  it('aggregates Today summary view correctly', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const wsId = 'ws-demo-a';

    const summary = await getTodaySummary(db, wsId);
    expect(summary.todayDate).toBeDefined();
    expect(summary.draftQuotesCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(summary.deliveriesToday)).toBe(true);
    expect(Array.isArray(summary.openTasks)).toBe(true);
  });
});
