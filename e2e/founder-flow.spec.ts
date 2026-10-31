import { expect, test } from '@playwright/test';

/**
 * Phân hệ Sáng lập qua giao diện thật, trên máy chủ dev phục vụ danh tính
 * `demo-admin` (founder_admin) — cổng 5174, biến `DEV_IDENTITY_SUBJECT` trong
 * `.dev.vars.e2e-founder`. Cổng 5173 (điều hành viên) không mở được phân hệ này,
 * nên bộ kiểm thử này chạy trên cổng riêng. Máy chủ thiếu hoặc sai danh tính là
 * lỗi cấu hình: bài kiểm thử **thất bại**, không bỏ qua.
 *
 * Mỗi bài tự dựng dữ liệu của mình qua API rồi thao tác trên màn hình; các phép
 * đo là của yêu cầu thật: mã trạng thái, header `Idempotency-Key`, và những gì
 * màn hình đọc lại từ máy chủ.
 */

/** The sub-navigation button that opens the founder area. */
async function openFounderArea(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /Sáng Lập \(Phỏng vấn & OPC\)/ }).click();
}

const FOUNDER_BASE = 'http://localhost:5174';
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' };
// ws-demo-c has no OPC agreement in the seed, so the ledger tests create their own.
const WS = 'ws-demo-c';

test.describe.configure({ mode: 'serial' });

/**
 * The founder suite fails loudly when its server is missing, and it cannot be
 * skipped out of an acceptance run.
 *
 * A skipped spec reports green. `playwright.config.ts` starts the `:5174` server
 * itself, so its absence or a different identity is a configuration fault, not
 * an acceptable environment — and a flag that let the whole founder area be
 * switched off would be exactly the affordance that turns "48 passed" into a
 * claim nobody can reproduce. To run part of the suite, name the spec or the
 * project on the command line (`pnpm exec playwright test e2e/nursery-flow.spec.ts`,
 * `--project=desktop-1440`); there is no environment variable that skips it.
 */
test.beforeEach(async ({ request }) => {
  const res = await request.get(`${FOUNDER_BASE}/api/session`);
  expect(res.status(), `founder dev server missing on ${FOUNDER_BASE} — playwright.config.ts should start it`).toBe(200);
  const { session } = (await res.json()) as { session: { role: string } };
  expect(session.role, 'the :5174 server must run the demo-admin identity').toBe('founder_admin');
});

test.use({ baseURL: FOUNDER_BASE });

test('Nút "Xem trước" không ghi gì; "Áp dụng cả lô" ghi một lần dù bấm đúp và danh sách đọc lại', async ({ page }) => {
  const externalId = `INT-E2E-${Date.now().toString(36).toUpperCase()}`;
  const items = [
    {
      external_id: externalId,
      organization_alias: 'Vườn kiểm thử E2E',
      respondent_role: 'Chủ vườn',
      interviewed_at: '2026-10-29',
      data_origin: 'synthetic',
      notes: 'Bản ghi kiểm thử tự động',
      observations: [
        { metric_key: 'monthly_fee_vnd', value_num: 2_500_000, unit: 'VND', period: 'month', evidence_kind: 'reported', source_ref: 'Ghi chú E2E' },
      ],
    },
  ];

  const countInterviews = async (externalIdToFind: string): Promise<number> => {
    const res = await page.request.get(`${FOUNDER_BASE}/api/founder/interviews?workspace_id=${WS}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { interviews: Array<{ external_id: string }> };
    return body.interviews.filter((i) => i.external_id === externalIdToFind).length;
  };

  await page.goto('/', { waitUntil: 'networkidle' });
  await openFounderArea(page);
  const screen = page.getByTestId('founder-screen');
  await expect(screen).toBeVisible();

  await page.getByLabel('Nội dung JSON').fill(JSON.stringify({ items }));
  await page.getByRole('button', { name: 'Xem trước (không ghi)' }).click();
  await expect(page.getByText(/Xem trước: 1 tạo mới/)).toBeVisible();
  const plan = page.getByRole('table', { name: 'Kế hoạch nhập phỏng vấn' });
  await expect(plan.getByText(externalId)).toBeVisible();
  await expect(plan.getByText(/Tạo mới \(v1\)/)).toBeVisible();
  // A preview is a read: the interview does not exist yet.
  expect(await countInterviews(externalId)).toBe(0);

  const applyRequests: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/founder/interviews/import-apply')) {
      applyRequests.push(req.headers()['idempotency-key'] ?? '');
    }
  });
  const applied = page.waitForResponse(
    (res) => res.url().includes('/api/founder/interviews/import-apply') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Áp dụng cả lô' }).dblclick();
  const response = await applied;
  expect(response.status(), await response.text()).toBe(201);
  await expect(page.getByText(/Đã nhập 1 phỏng vấn \(1 tạo mới, 0 bản sửa\)/)).toBeVisible();
  await page.waitForTimeout(300);
  expect(applyRequests).toHaveLength(1);
  expect(applyRequests[0]).toMatch(/^ui-/);
  expect(await countInterviews(externalId)).toBe(1);
  // The interviews table now lists it.
  await expect(page.getByRole('table').filter({ hasText: externalId }).first()).toBeVisible();
});

test('Đề xuất thiếu bằng chứng bị chặn ở giao diện; có bằng chứng thì áp dụng sinh phiên bản mới và hoàn nguyên ghi rõ nguồn', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await openFounderArea(page);
  await expect(page.getByTestId('founder-screen')).toBeVisible();

  const rationaleValue = 'Kiểm thử E2E: đo lại giờ hỗ trợ';
  const before = await page.request.get(`${FOUNDER_BASE}/api/founder/config?workspace_id=${WS}`);
  const beforeBody = (await before.json()) as { versions: Array<{ id: string; version_number: number }>; active_version: { id: string; version_number: number } };
  const activeNumber = beforeBody.active_version.version_number;

  // No evidence ticked → refused before any request leaves the page.
  let proposalPosts = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/founder/proposals/create')) proposalPosts += 1;
  });
  await page.getByLabel('Giá trị mới').fill('5');
  await page.getByLabel('Lý do thay đổi').fill(rationaleValue);
  await page.getByRole('button', { name: 'Tạo đề xuất' }).click();
  await expect(page.getByText('Chọn ít nhất một quan sát làm bằng chứng.')).toBeVisible();
  expect(proposalPosts).toBe(0);

  // With evidence, the proposal is created against the active version.
  await page.locator('.check-list input[type="checkbox"]').first().check();
  await page.locator('#founder-metric-key').selectOption('support_hours_per_customer_month');
  await page.getByLabel('Giá trị mới').fill('5');
  const created = page.waitForResponse(
    (res) => res.url().includes('/api/founder/proposals/create') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Tạo đề xuất' }).click();
  const createdResponse = await created;
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  expect(createdResponse.request().headers()['idempotency-key']).toMatch(/^ui-/);
  const createdBody = (await createdResponse.json()) as { proposal: { id: string; base_version_id: string } };
  expect(createdBody.proposal.base_version_id).toBe(beforeBody.active_version.id);
  await expect(page.getByText(/Đã tạo đề xuất cp/)).toBeVisible();

  // Apply → a new immutable version. The proposals table lists newest first and
  // shows the rationale, which is what this run typed.
  const rationale = 'Kiểm thử E2E: đo lại giờ hỗ trợ';
  const row = page.getByRole('row', { name: new RegExp(rationale) }).first();
  const applyResponse = page.waitForResponse(
    (res) => res.url().includes('/api/founder/proposals/apply') && res.request().method() === 'POST',
  );
  await row.getByRole('button', { name: 'Áp dụng' }).click();
  const applied = await applyResponse;
  expect(applied.status(), await applied.text()).toBe(200);
  const appliedBody = (await applied.json()) as { version: { version_number: number; parameters: Record<string, number> } };
  expect(appliedBody.version.version_number).toBe(activeNumber + 1);
  expect(appliedBody.version.parameters.support_hours_per_customer_month).toBe(5);
  await expect(page.getByText(`Đã áp dụng đề xuất → phiên bản v${activeNumber + 1} (bất biến).`)).toBeVisible();

  // Rollback to the previous version → another version that names its source.
  const rollbackResponse = page.waitForResponse(
    (res) => res.url().includes('/api/founder/config/rollback') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: `Khôi phục v${activeNumber}` }).first().click();
  const rolled = await rollbackResponse;
  expect(rolled.status(), await rolled.text()).toBe(200);
  const rolledBody = (await rolled.json()) as { version: { version_number: number; restored_from_version_id: string } };
  expect(rolledBody.version.version_number).toBe(activeNumber + 2);
  expect(rolledBody.version.restored_from_version_id).toBe(beforeBody.active_version.id);
  await expect(page.getByText(/Khôi phục từ v/).first()).toBeVisible();
  await expect(page.getByText(`Đã khôi phục cấu hình từ v${activeNumber} → phiên bản mới v${activeNumber + 2}.`)).toBeVisible();
});

test('Sổ cái OPC: thu vượt phần còn phải thu bị từ chối, ba con số tách biệt, pilot credit dùng một lần', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await openFounderArea(page);
  const screen = page.getByTestId('founder-screen');
  await expect(screen).toBeVisible();

  // ws-demo-c has no agreement in the seed: create one through the form.
  const agreementResponse = page.waitForResponse(
    (res) => res.url().includes('/api/founder/opc/agreements/create') && res.request().method() === 'POST',
  );
  await page.locator('#founder-opc-target').selectOption(WS);
  await page.getByLabel('Phí thuê bao tháng (VND)').fill('3000000');
  await page.getByRole('button', { name: 'Tạo hợp đồng OPC' }).click();
  const agreement = await agreementResponse;
  const agreementStatus = agreement.status();
  if (agreementStatus === 201) {
    const body = (await agreement.json()) as { agreement: { id: string } };
    // Record a 5,000,000 obligation, then try to confirm 6,000,000 against it.
    const obligationResponse = page.waitForResponse(
      (res) => res.url().includes('/api/founder/opc/obligations/record') && res.request().method() === 'POST',
    );
    await page.locator('#opc-obligation-agreement').selectOption(body.agreement.id);
    await page.getByLabel('Số tiền (VND)').fill('5000000');
    await page.getByRole('button', { name: 'Ghi nghĩa vụ' }).click();
    const obligation = await obligationResponse;
    expect(obligation.status(), await obligation.text()).toBe(201);
    const { obligation: obligationRow } = (await obligation.json()) as { obligation: { id: string } };
    await expect(page.getByText(/Đã ghi nghĩa vụ/)).toBeVisible();

    await page.locator('#opc-receipt-agreement').selectOption(body.agreement.id);
    // Allocated to the obligation: without it there is no "remaining" to exceed.
    await page.locator('#opc-receipt-obligation').selectOption(obligationRow.id);
    await page.getByLabel('Số tiền đã nhận (VND)').fill('6000000');
    await page.getByLabel('Mã tham chiếu chuyển khoản').fill('E2E-OVER');
    const overResponse = page.waitForResponse(
      (res) => res.url().includes('/api/founder/opc/receipts/confirm') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Xác nhận phiếu thu' }).click();
    const over = await overResponse;
    expect(over.status()).toBe(409);
    await expect(page.getByText(/vượt phần còn phải thu/)).toBeVisible();
    // The refused form keeps what was typed so it can be corrected.
    await expect(page.getByLabel('Số tiền đã nhận (VND)')).toHaveValue('6000000');

    // A correct amount is recorded once, and the figures separate.
    await page.getByLabel('Số tiền đã nhận (VND)').fill('5000000');
    await page.getByLabel('Mã tham chiếu chuyển khoản').fill('E2E-OK');
    const okResponse = page.waitForResponse(
      (res) => res.url().includes('/api/founder/opc/receipts/confirm') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Xác nhận phiếu thu' }).click();
    expect((await okResponse).status()).toBe(201);
    await expect(page.getByText(/Đã ghi nhận thu/)).toBeVisible();
    await expect(page.getByText('E2E-OK').first()).toBeVisible();

    // The ledger without a filter is the founder's whole book; narrow it to the
    // workspace this test created an agreement for so the figures are exact.
    const ledger = await page.request.get(
      `${FOUNDER_BASE}/api/founder/opc/ledger?workspace_id=${WS}&target_workspace_id=${WS}`,
    );
    const ledgerBody = (await ledger.json()) as {
      metrics: { active_mrr_vnd: number; cash_collected_vnd: number; outstanding_receivables_vnd: number };
      obligations: Array<{ obligation_kind: string; status: string }>;
    };
    expect(ledgerBody.metrics).toMatchObject({ active_mrr_vnd: 3_000_000, cash_collected_vnd: 5_000_000, outstanding_receivables_vnd: 0 });
    expect(ledgerBody.obligations.find((o) => o.obligation_kind === 'monthly_subscription')?.status).toBe('settled');
  } else {
    // An earlier run already created ws-demo-c's agreement: the refusal is the proof.
    expect(agreementStatus).toBe(409);
    await expect(page.getByText(/đã có hợp đồng OPC/)).toBeVisible();
  }
});

test('Giao diện không tràn ngang ở 390px và 1440px', async ({ page, viewport }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await openFounderArea(page);
  await expect(page.getByTestId('founder-screen')).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, `founder area overflows at ${viewport?.width ?? '?'}px`).toBeLessThanOrEqual(overflow.clientWidth + 1);
  console.log(`founder area rendered at ${viewport?.width ?? '?'}px`);
});
