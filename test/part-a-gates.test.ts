import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { setMembershipStore, setVerifier } from '../src/worker/index.ts';
import { createSqliteD1 } from './sqlite-d1-harness.ts';

const ORIGIN = 'https://pilot.example.test';
const CTX: { access?: unknown } = {};

describe('Part A Full HTTP Route & Security Gates (Phases 2, 3, 4)', () => {
  beforeEach(() => {
    setVerifier(null);
    setMembershipStore(null);
  });

  afterEach(() => {
    setVerifier(null);
    setMembershipStore(null);
  });

  it('serves Phase 2 ops endpoints to workspace members and denies cross-tenant access', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const env = {
      APP_ENV: 'development',
      DEV_IDENTITY: 'demo-owner', // owner of ws-demo-a
      DB: db,
    };

    // 1. Today summary
    const todayRes = await worker.fetch(
      new Request(`${ORIGIN}/api/ops/today?workspace_id=ws-demo-a`),
      env,
      CTX,
    );
    expect(todayRes.status).toBe(200);
    const todayBody = (await todayRes.json()) as { summary: { draftQuotesCount: number } };
    expect(todayBody.summary.draftQuotesCount).toBeGreaterThanOrEqual(1);

    // 2. Quote chains list
    const chainsRes = await worker.fetch(
      new Request(`${ORIGIN}/api/quote-chains?workspace_id=ws-demo-a`),
      env,
      CTX,
    );
    expect(chainsRes.status).toBe(200);
    const chainsBody = (await chainsRes.json()) as { chains: Array<{ id: string }> };
    expect(chainsBody.chains.length).toBeGreaterThanOrEqual(3);

    // 3. Printable A4 quote HTML
    const printRes = await worker.fetch(
      new Request(
        `${ORIGIN}/api/quote-revisions/print?workspace_id=ws-demo-a&revision_id=qr-demo-01-r2`,
      ),
      env,
      CTX,
    );
    expect(printRes.status).toBe(200);
    expect(printRes.headers.get('content-type')).toContain('text/html');
    const html = await printRes.text();
    expect(html).toContain('BÁO GIÁ — KHÔNG PHẢI HÓA ĐƠN THUẾ');

    // 4. Cross-tenant access to ws-shop-q1 by ws-demo-a owner is denied (403)
    const crossRes = await worker.fetch(
      new Request(`${ORIGIN}/api/orders?workspace_id=ws-shop-q1`),
      env,
      CTX,
    );
    expect(crossRes.status).toBe(403);
  });

  it('enforces role separation: workspace_operator cannot confirm receipts or override under-deposit deliveries', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const operatorEnv = {
      APP_ENV: 'development',
      DEV_IDENTITY: 'demo-operator', // workspace_operator in ws-demo-a
      DB: db,
    };

    // Operator can create a pending receipt
    const createRcRes = await worker.fetch(
      new Request(`${ORIGIN}/api/receipts/create?workspace_id=ws-demo-a`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({
          order_id: 'ord-demo-01',
          amount_vnd: 1000000,
          reference: 'OP-RC-01',
        }),
      }),
      operatorEnv,
      CTX,
    );
    expect(createRcRes.status).toBe(201);
    const { receipt } = (await createRcRes.json()) as { receipt: { id: string } };

    // Operator CANNOT confirm receipt (`receipt.confirm` requires workspace_owner or founder_admin)
    const confirmByOpRes = await worker.fetch(
      new Request(`${ORIGIN}/api/receipts/confirm?workspace_id=ws-demo-a`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ receipt_id: receipt.id }),
      }),
      operatorEnv,
      CTX,
    );
    expect(confirmByOpRes.status).toBe(403);

    // Operator CANNOT override under-deposit delivery (`delivery.override_under_deposit`)
    const overrideByOpRes = await worker.fetch(
      new Request(`${ORIGIN}/api/deliveries/override?workspace_id=ws-demo-a`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({
          order_id: 'ord-demo-01',
          scheduled_date: '2026-10-30',
          reason: 'Thử vượt quyền',
        }),
      }),
      operatorEnv,
      CTX,
    );
    expect(overrideByOpRes.status).toBe(403);

    // Owner CAN confirm receipt
    const ownerEnv = {
      APP_ENV: 'development',
      DEV_IDENTITY: 'demo-owner',
      DB: db,
    };
    const confirmByOwnerRes = await worker.fetch(
      new Request(`${ORIGIN}/api/receipts/confirm?workspace_id=ws-demo-a`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ receipt_id: receipt.id }),
      }),
      ownerEnv,
      CTX,
    );
    expect(confirmByOwnerRes.status).toBe(200);
  });

  it('guards all Phase 3 /api/founder/* routes strictly for founder_admin', async () => {
    const { db } = createSqliteD1({ seedDemo: true });

    const ownerEnv = {
      APP_ENV: 'development',
      DEV_IDENTITY: 'demo-owner', // workspace_owner, NOT founder_admin
      DB: db,
    };

    const founderPaths = [
      '/api/founder/interviews',
      '/api/founder/config',
      '/api/founder/economics',
      '/api/founder/opc/ledger',
    ];

    for (const path of founderPaths) {
      const denied = await worker.fetch(
        new Request(`${ORIGIN}${path}?workspace_id=ws-demo-a`),
        ownerEnv,
        CTX,
      );
      expect(denied.status).toBe(403);
    }

    // Founder admin succeeds on all of them
    const adminEnv = {
      APP_ENV: 'development',
      DEV_IDENTITY: 'demo-admin',
      DB: db,
    };

    for (const path of founderPaths) {
      const allowed = await worker.fetch(
        new Request(`${ORIGIN}${path}?workspace_id=ws-demo-a`),
        adminEnv,
        CTX,
      );
      expect(allowed.status).toBe(200);
    }

    // Export CSV endpoint
    const csvRes = await worker.fetch(
      new Request(`${ORIGIN}/api/founder/interviews/export?workspace_id=ws-demo-a&format=csv`),
      adminEnv,
      CTX,
    );
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('content-type')).toContain('text/csv');
    const csvText = await csvRes.text();
    expect(csvText).toContain('INT-SADEC-001');
  });

  it('handles Founder batch import preview and apply via HTTP', async () => {
    const { db } = createSqliteD1({ seedDemo: true });
    const adminEnv = {
      APP_ENV: 'development',
      DEV_IDENTITY: 'demo-admin',
      DB: db,
    };

    const batchPayload = {
      items: [
        {
          external_id: 'INT-BATCH-101',
          organization_alias: 'Nhà Vườn Hoa Kiểng Cái Mơn',
          respondent_role: 'Chủ vườn',
          interviewed_at: '2026-10-26',
          data_origin: 'real',
          notes: 'Khảo sát qua điện thoại',
          observations: [
            {
              metric_key: 'willingness_to_pay_vnd',
              value_num: 3500000,
              unit: 'VND',
              period: 'month',
              evidence_kind: 'reported',
            },
          ],
        },
      ],
    };

    const previewRes = await worker.fetch(
      new Request(`${ORIGIN}/api/founder/interviews/import-preview?workspace_id=ws-demo-a`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify(batchPayload),
      }),
      adminEnv,
      CTX,
    );
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as {
      preview: { interviews_count: number; observations_count: number; valid: boolean };
    };
    expect(previewBody.preview.valid).toBe(true);
    expect(previewBody.preview.interviews_count).toBe(1);

    const applyRes = await worker.fetch(
      new Request(`${ORIGIN}/api/founder/interviews/import-apply?workspace_id=ws-demo-a`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify(batchPayload),
      }),
      adminEnv,
      CTX,
    );
    expect(applyRes.status).toBe(201);
    const applyBody = (await applyRes.json()) as { applied_count: number };
    expect(applyBody.applied_count).toBe(1);
  });
});
