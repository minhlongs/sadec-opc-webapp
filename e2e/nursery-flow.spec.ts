import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Vườn ươm: chốt báo giá và sửa bản mới qua giao diện thật.
 *
 * Mỗi lần chạy tự tạo một chuỗi báo giá mới qua API (danh tính dev mặc định là
 * điều hành viên của ws-demo-a), phát hành nó, rồi thao tác trên màn hình như
 * chủ vườn: dữ liệu demo cục bộ không bị tiêu hao giữa các lần chạy. Các phép
 * đo là của yêu cầu thật: header `Idempotency-Key` do giao diện gửi, mã trạng
 * thái máy chủ trả về, và số tiền cọc do máy chủ tính — không phải số hiển thị.
 */

const WS = 'ws-demo-a';
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' };

interface IssuedQuote {
  reference: string;
  revisionId: string;
  totalVnd: number;
}

/** Một chuỗi báo giá mới đã phát hành, chưa có đơn. */
async function issuedQuote(request: APIRequestContext, tag: string): Promise<IssuedQuote> {
  const productsRes = await request.get(`/api/products?workspace_id=${WS}`);
  expect(productsRes.status()).toBe(200);
  const { products } = (await productsRes.json()) as { products: { id: string }[] };
  const customersRes = await request.get(`/api/customers?workspace_id=${WS}`);
  expect(customersRes.status()).toBe(200);
  const { customers } = (await customersRes.json()) as { customers: { id: string }[] };
  expect(products.length).toBeGreaterThan(0);
  expect(customers.length).toBeGreaterThan(0);

  const reference = `E2E-${tag}-${Date.now().toString(36).toUpperCase()}`;
  const chainRes = await request.post(`/api/quote-chains/create?workspace_id=${WS}`, {
    headers: SAME_ORIGIN,
    data: {
      customer_id: customers[0]!.id,
      reference,
      lines: [{ product_id: products[0]!.id, quantity: 3 }],
    },
  });
  expect(chainRes.status(), await chainRes.text()).toBe(201);
  // The route answers with the chain itself at the top level.
  const chain = (await chainRes.json()) as { revisions: { id: string; total_vnd: number }[] };
  const revision = chain.revisions[0]!;

  const issueRes = await request.post(`/api/quote-revisions/issue?workspace_id=${WS}`, {
    headers: SAME_ORIGIN,
    data: { revision_id: revision.id },
  });
  expect(issueRes.status(), await issueRes.text()).toBe(200);
  return { reference, revisionId: revision.id, totalVnd: revision.total_vnd };
}

test.describe('Vườn ươm: chốt báo giá qua giao diện', () => {
  test('chốt một lần dù nhấp đúp, có Idempotency-Key, cọc do máy chủ tính, bảng đơn đọc lại', async ({
    page,
    viewport,
  }) => {
    const quote = await issuedQuote(page.request, 'CHOT');
    const acceptRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/quote-revisions/accept')) {
        acceptRequests.push(req.headers()['idempotency-key'] ?? '');
      }
    });

    await page.goto('/', { waitUntil: 'networkidle' });
    const row = page.getByRole('row', { name: new RegExp(quote.reference) });
    await expect(row).toBeVisible();
    await expect(row.getByText('issued')).toBeVisible();

    const accepted = page.waitForResponse(
      (res) => res.url().includes('/api/quote-revisions/accept') && res.request().method() === 'POST',
    );
    await row.getByRole('button', { name: 'Khách chốt → Tạo đơn' }).dblclick();
    const response = await accepted;
    expect(response.status()).toBe(201);
    const body = (await response.json()) as {
      order: { order_code: string; deposit_required_vnd: number; pilot_credit_applied_vnd: number; status: string };
    };
    // 30% do máy chủ áp, cắt phần lẻ về 0; giao diện không gửi tỷ lệ nào.
    expect(body.order.deposit_required_vnd).toBe(Math.trunc((quote.totalVnd * 3000) / 10000));
    expect(body.order.pilot_credit_applied_vnd).toBe(0);
    expect(body.order.status).toBe('pending_deposit');
    expect(response.request().postDataJSON()).toEqual({ revision_id: quote.revisionId });

    // Giao diện báo thành công chỉ sau khi máy chủ trả lời, rồi đọc lại bảng đơn.
    await expect(page.getByText(`Khách đã chốt ${quote.reference} → Tạo đơn ${body.order.order_code}`)).toBeVisible();
    const orderRow = page.getByRole('row', { name: new RegExp(body.order.order_code) });
    await expect(orderRow).toBeVisible();
    await expect(orderRow.getByText('pending_deposit')).toBeVisible();
    await expect(row.getByText('accepted')).toBeVisible();

    // Nhấp đúp chỉ tạo một yêu cầu, và yêu cầu đó mang khóa của giao diện.
    await page.waitForTimeout(300);
    expect(acceptRequests).toHaveLength(1);
    expect(acceptRequests[0]).toMatch(/^ui-/);
    console.log(`accepted ${quote.reference} as ${body.order.order_code} at ${viewport?.width ?? '?'}px`);
  });

  test('"Sửa bản mới" tạo bản nháp v2 và đánh dấu bản đã phát hành là superseded', async ({ page }) => {
    const quote = await issuedQuote(page.request, 'SUA');
    await page.goto('/', { waitUntil: 'networkidle' });
    const row = page.getByRole('row', { name: new RegExp(`${quote.reference}.*v1`) });
    await expect(row).toBeVisible();

    const revised = page.waitForResponse(
      (res) => res.url().includes('/api/quote-revisions/revise') && res.request().method() === 'POST',
    );
    await row.getByRole('button', { name: 'Sửa bản mới' }).click();
    const response = await revised;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().headers()['idempotency-key']).toMatch(/^ui-/);
    expect(response.request().postDataJSON()).toEqual({ revision_id: quote.revisionId });

    await expect(page.getByText('Đã tạo bản sửa v2')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(`${quote.reference}.*v1`) }).getByText('superseded')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(`${quote.reference}.*v2`) }).getByText('draft')).toBeVisible();
  });
});
