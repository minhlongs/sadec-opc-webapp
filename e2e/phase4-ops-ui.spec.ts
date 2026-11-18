import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Phase 4 Ops UI E2E — Catalog CRUD/search, Customer CRUD/search, Pending Receipt
 * record + void + Today KPI counter, RBAC visibility gates, optimistic-lock 409
 * refusal banner, and zero horizontal overflow on 390×844 and 1440×900.
 */

const WS = 'ws-demo-a';
const FOUNDER_BASE = 'http://localhost:5174';
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' };

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
}

async function createOrderViaApi(request: APIRequestContext, tag: string): Promise<{
  orderId: string;
  orderCode: string;
  totalVnd: number;
}> {
  const productsRes = await request.get(`/api/products?workspace_id=${WS}`);
  expect(productsRes.status()).toBe(200);
  const { products } = (await productsRes.json()) as { products: { id: string }[] };

  const customersRes = await request.get(`/api/customers?workspace_id=${WS}`);
  expect(customersRes.status()).toBe(200);
  const { customers } = (await customersRes.json()) as { customers: { id: string }[] };

  const reference = `E2E-P4-${tag}-${Date.now().toString(36).toUpperCase()}`;
  const chainRes = await request.post(`/api/quote-chains/create?workspace_id=${WS}`, {
    headers: SAME_ORIGIN,
    data: {
      customer_id: customers[0]!.id,
      reference,
      lines: [{ product_id: products[0]!.id, quantity: 2 }],
    },
  });
  expect(chainRes.status(), await chainRes.text()).toBe(201);
  const chain = (await chainRes.json()) as { revisions: { id: string }[] };
  const revisionId = chain.revisions[0]!.id;

  const issueRes = await request.post(`/api/quote-revisions/issue?workspace_id=${WS}`, {
    headers: SAME_ORIGIN,
    data: { revision_id: revisionId },
  });
  expect(issueRes.status(), await issueRes.text()).toBe(200);

  const acceptRes = await request.post(`/api/quote-revisions/accept?workspace_id=${WS}`, {
    headers: SAME_ORIGIN,
    data: { revision_id: revisionId },
  });
  expect(acceptRes.status(), await acceptRes.text()).toBe(201);
  const order = (await acceptRes.json()) as {
    id: string;
    order_code: string;
    total_vnd: number;
  };
  return { orderId: order.id, orderCode: order.order_code, totalVnd: order.total_vnd };
}

test('operator: customer create/search/edit + 409 lock banner + record & void pending receipt updates Today KPI', async ({
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const order = await createOrderViaApi(request, suffix);

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Danh mục hàng' })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  // Operator does NOT see product create/edit controls
  const catalogSection = page.locator('#ops-catalog');
  await expect(catalogSection.getByRole('button', { name: 'Thêm mặt hàng' })).toHaveCount(0);
  await expect(catalogSection.getByRole('button', { name: 'Sửa' })).toHaveCount(0);

  // Customer create + search + edit + stale-lock 409
  const customerSection = page.locator('#ops-customers');
  const custName = `Nhà vườn E2E ${suffix}`;
  await customerSection.getByRole('button', { name: 'Thêm khách' }).click();
  await customerSection.getByLabel('Tên khách / đơn vị').fill(custName);
  await customerSection.getByLabel('Người liên hệ').fill('Chị Lan');
  await customerSection.getByLabel('Số điện thoại').fill('0909123456');
  await customerSection.getByRole('button', { name: 'Lưu khách hàng' }).click();
  await expect(page.getByText(`Đã thêm khách hàng "${custName}".`)).toBeVisible();

  await customerSection.getByLabel('Tìm khách hàng').fill(suffix);
  const custRow = customerSection.locator('tbody tr').filter({ hasText: custName });
  await expect(custRow).toBeVisible();

  // Open edit form, then mutate the same customer concurrently on the backend so expected_updated_at goes stale
  await custRow.getByRole('button', { name: 'Sửa' }).click();
  const listRes = await request.get(`/api/customers?workspace_id=${WS}&q=${encodeURIComponent(suffix)}`);
  const { customers } = (await listRes.json()) as {
    customers: { id: string; updated_at: string; name: string }[];
  };
  const targetCust = customers.find((c) => c.name === custName)!;
  // Advance updated_at on server
  await page.waitForTimeout(15);
  const bumpRes = await request.post(`/api/customers/update?workspace_id=${WS}`, {
    headers: { ...SAME_ORIGIN, 'Idempotency-Key': `bump-cust-${suffix}` },
    data: {
      customer_id: targetCust.id,
      expected_updated_at: targetCust.updated_at,
      name: custName,
      contact_name: 'Anh Minh (cập nhật ngoài)',
      phone: '0909123456',
      address: null,
      note: null,
    },
  });
  expect(bumpRes.status(), await bumpRes.text()).toBe(200);

  // Submitting stale form in UI surfaces 409 conflict alert
  await customerSection.getByLabel('Người liên hệ').fill('Chị Lan (cũ)');
  await customerSection.getByRole('button', { name: 'Cập nhật khách hàng' }).click();
  await expect(customerSection.getByRole('alert')).toContainText(/cập nhật|tải lại/i);

  // Close stale form, re-open fresh row, and update cleanly
  await customerSection.getByRole('button', { name: 'Hủy' }).click();
  await custRow.getByRole('button', { name: 'Sửa' }).click();
  await customerSection.getByLabel('Người liên hệ').fill('Chị Lan (mới)');
  await customerSection.getByRole('button', { name: 'Cập nhật khách hàng' }).click();
  await expect(page.getByText(`Đã cập nhật khách hàng "${custName}".`)).toBeVisible();

  // Read baseline deposits_to_confirm KPI
  const kpiCard = page.getByTestId('today-deposits-to-confirm');
  const beforeCount = Number((await kpiCard.locator('.bento-kpi-card__value').textContent()) ?? '0');

  // Record a pending receipt via UI
  const ordersSection = page.locator('#ops-orders');
  const rcRef = `RC-${suffix.toUpperCase()}`;
  await ordersSection.getByRole('button', { name: 'Ghi phiếu thu chờ' }).click();
  await ordersSection.getByLabel('Đơn hàng').selectOption(order.orderId);
  await ordersSection.getByLabel('Số tiền thu (đồng)').fill('50000');
  await ordersSection.getByLabel('Mã tham chiếu / sao kê').fill(rcRef);
  await ordersSection.getByRole('button', { name: 'Lưu phiếu thu chờ' }).click();
  await expect(page.getByText('Đã ghi phiếu thu chờ xác nhận.')).toBeVisible();

  await expect(kpiCard.locator('.bento-kpi-card__value')).toHaveText(String(beforeCount + 1));

  const receiptRow = ordersSection.locator('tbody tr').filter({ hasText: rcRef });
  await expect(receiptRow).toBeVisible();
  // Operator cannot confirm receipts
  await expect(receiptRow.getByRole('button', { name: 'Xác nhận thực thu' })).toHaveCount(0);

  // Void the pending receipt with an explicit reason
  await receiptRow.getByRole('button', { name: 'Hủy phiếu chờ' }).click();
  const voidReason = `Khách chuyển nhầm mã ${suffix}`;
  await receiptRow.getByLabel('Lý do hủy phiếu chờ').fill(voidReason);
  await receiptRow.getByRole('button', { name: 'Xác nhận hủy phiếu' }).click();
  await expect(page.getByText(`Đã hủy phiếu thu chờ ${rcRef}`)).toBeVisible();
  await expect(receiptRow).toContainText('voided');
  await expect(receiptRow).toContainText(`Lý do hủy: ${voidReason}`);
  await expect(kpiCard.locator('.bento-kpi-card__value')).toHaveText(String(beforeCount));

  await assertNoHorizontalOverflow(page);
});

test('founder_admin (:5174): catalog create (0 VND allowed), search, edit, 409 lock conflict, and receipt confirm visibility', async ({
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const order = await createOrderViaApi(request, `adm-${suffix}`);
  const rcRef = `RC-ADM-${suffix.toUpperCase()}`;
  const createRcRes = await request.post(`${FOUNDER_BASE}/api/receipts/create?workspace_id=${WS}`, {
    headers: { ...SAME_ORIGIN, 'Idempotency-Key': `rc-adm-${suffix}` },
    data: { order_id: order.orderId, amount_vnd: 40000, reference: rcRef },
  });
  expect(createRcRes.status(), await createRcRes.text()).toBe(201);

  await page.goto(FOUNDER_BASE, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Danh mục hàng' })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  const catalogSection = page.locator('#ops-catalog');
  const prodName = `Cúc mầm xôi mẫu tặng ${suffix}`;
  await catalogSection.getByRole('button', { name: 'Thêm mặt hàng' }).click();
  await catalogSection.getByLabel('Tên mặt hàng').fill(prodName);
  await catalogSection.getByLabel('Giống / loài').fill('Cúc mầm xôi');
  await catalogSection.getByLabel('Cỡ / quy cách').fill('Chậu 20cm');
  await catalogSection.getByLabel('Phân loại').fill('Hàng mẫu');
  await catalogSection.getByLabel(/Đơn giá/).fill('0');
  await catalogSection.getByLabel('Đơn vị tính').fill('chậu');
  await catalogSection.getByRole('button', { name: 'Lưu mặt hàng' }).click();
  await expect(page.getByText(`Đã thêm mặt hàng "${prodName}".`)).toBeVisible();

  await catalogSection.getByLabel('Tìm mặt hàng').fill(suffix);
  const prodRow = catalogSection.locator('tbody tr').filter({ hasText: prodName });
  await expect(prodRow).toBeVisible();
  await expect(prodRow).toContainText('0 đ');

  // Trigger stale optimistic-lock 409 on product update
  await prodRow.getByRole('button', { name: 'Sửa' }).click();
  const listRes = await request.get(
    `${FOUNDER_BASE}/api/products?workspace_id=${WS}&q=${encodeURIComponent(suffix)}`,
  );
  const { products } = (await listRes.json()) as {
    products: { id: string; updated_at: string; name: string; unit: string }[];
  };
  const targetProd = products.find((p) => p.name === prodName)!;
  await page.waitForTimeout(15);
  const bumpRes = await request.post(`${FOUNDER_BASE}/api/products/update?workspace_id=${WS}`, {
    headers: { ...SAME_ORIGIN, 'Idempotency-Key': `bump-prod-${suffix}` },
    data: {
      product_id: targetProd.id,
      expected_updated_at: targetProd.updated_at,
      name: prodName,
      species: 'Cúc mầm xôi',
      size_class: 'Chậu 25cm',
      grade: 'Loại A',
      price_vnd: 55000,
      unit: targetProd.unit,
      stock_note: null,
    },
  });
  expect(bumpRes.status(), await bumpRes.text()).toBe(200);

  await catalogSection.getByLabel(/Đơn giá/).fill('45000');
  await catalogSection.getByRole('button', { name: 'Cập nhật mặt hàng' }).click();
  await expect(catalogSection.getByRole('alert')).toContainText(/cập nhật|tải lại/i);

  // Close stale form, re-open fresh row, and save updated price
  await catalogSection.getByRole('button', { name: 'Hủy' }).click();
  await prodRow.getByRole('button', { name: 'Sửa' }).click();
  await catalogSection.getByLabel(/Đơn giá/).fill('65000');
  await catalogSection.getByRole('button', { name: 'Cập nhật mặt hàng' }).click();
  await expect(page.getByText(`Đã cập nhật mặt hàng "${prodName}".`)).toBeVisible();
  await expect(prodRow).toContainText('65.000 đ');

  // Owner/founder_admin sees "Xác nhận thực thu" and confirms pending receipt
  const ordersSection = page.locator('#ops-orders');
  const receiptRow = ordersSection.locator('tbody tr').filter({ hasText: rcRef });
  await expect(receiptRow).toBeVisible();
  await receiptRow.getByRole('button', { name: 'Xác nhận thực thu' }).click();
  await expect(page.getByText(`Đã xác nhận phiếu thu ${rcRef}`)).toBeVisible();
  await expect(receiptRow).toContainText('confirmed');

  await assertNoHorizontalOverflow(page);
});
