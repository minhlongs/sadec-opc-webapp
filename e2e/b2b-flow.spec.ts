import { expect, test } from '@playwright/test';

test('navigates B2B Floriculture Marketplace, Hub Dispatch, and Inspection Settlement', async ({
  page,
  viewport,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  // Switch to B2B Marketplace tab
  await page.getByRole('button', { name: 'Chợ Sỉ Hoa Kiểng B2B' }).click();
  await expect(page.getByText('Sàn B2B Hoa Kiểng Sa Đéc → TP.HCM')).toBeVisible();
  await expect(page.getByText(/Cọc tươi 30–50% VietQR Escrow/i)).toBeVisible();

  // Switch to Marketing Landing & ROI Calculator tab
  await page.getByRole('button', { name: 'Giới Thiệu & Máy Tính Giá Gốc' }).click();
  await expect(
    page.getByText(/Máy Tính Tiết Kiệm Giá Gốc & Tiền Cọc Bảo Chứng VietQR Escrow/i),
  ).toBeVisible();

  // Switch to CMO & GTM Hub tab
  await page.getByRole('button', { name: 'CMO & GTM Hub' }).click();
  await expect(
    page.getByText(/Trung Tâm Tác Chiến CMO & Field SDR/i),
  ).toBeVisible();

  // Switch to Hub Dispatch tab
  await page.getByRole('button', { name: 'Điều Phối Hub Sa Đéc' }).click();
  await expect(page.getByText('Điều Phối Gom Hàng & Cross-docking Hub Sa Đéc')).toBeVisible();

  // Switch to Inspection & Settlement tab
  await page.getByRole('button', { name: 'Nghiệm Thu & Đối Soát' }).click();
  await expect(page.getByText('Trạm Nghiệm Thu & Đối Soát Tự Động tại Shop TP.HCM')).toBeVisible();

  expect(errors).toEqual([]);
  console.log(`verified B2B tabs at ${viewport?.width ?? '?'}px`);
});

/**
 * Hợp đồng Agent Bridge, Command Palette, JSON-LD View và Proposal HUD.
 * Các kiểu dưới đây mô tả đúng bề mặt mà `window.__SADEC_AGENT_BRIDGE__` phải có.
 */
interface BridgeLot {
  id: string;
  revision: string;
  moq_units: number;
  available_units: number;
}

/**
 * What the bridge reports for a list request: a status rather than a bare array.
 * `OK` may still be empty (nothing is published); `UNAVAILABLE` means the read
 * failed, which is not the same statement and must not be read as "sold out".
 */
interface BridgeLotList {
  status: 'OK' | 'STALE' | 'UNAVAILABLE';
  lots: BridgeLot[];
  stale: boolean;
  message: string | null;
}

interface BridgeQuote {
  grossTotalVnd: number;
  depositRequiredVnd: number;
}

interface AgentBridge {
  listSupplyLots: () => Promise<BridgeLotList>;
  quoteBooking: (input: { lotId: string; quantity: number }) => Promise<BridgeQuote>;
  proposeBooking: (input: {
    lotId: string;
    quantity: number;
    expectedRevision: string;
  }) => Promise<unknown>;
  verifyQrToken: (token: string) => Promise<unknown>;
}

type BridgeWindow = Window & { __SADEC_AGENT_BRIDGE__?: AgentBridge };

const BRIDGE_METHODS = ['listSupplyLots', 'quoteBooking', 'proposeBooking', 'verifyQrToken'];

async function openMarketplace(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Chợ Sỉ Hoa Kiểng B2B' }).click();
  await expect(page.getByText('Sàn B2B Hoa Kiểng Sa Đéc → TP.HCM')).toBeVisible();
}

async function expectCommandPaletteToggles(page: import('@playwright/test').Page): Promise<void> {
  await openMarketplace(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function expectJsonLdViewOnFirstLot(page: import('@playwright/test').Page): Promise<void> {
  await openMarketplace(page);
  const firstCard = page.locator('.lot-card').first();
  await expect(firstCard).toBeVisible();
  await firstCard.getByRole('button', { name: /JSON-LD/i }).click();
  const jsonLd = firstCard.locator('.lot-card__jsonld');
  await expect(jsonLd).toBeVisible();
  const text = (await jsonLd.textContent()) ?? '';
  expect(text.includes('schema.org') || text.includes('"@type"')).toBe(true);
}

test.describe('Agent Bridge (WebMCP)', () => {
  test.beforeEach(async ({ page }) => {
    await openMarketplace(page);
    await page.waitForFunction(
      () => (window as BridgeWindow).__SADEC_AGENT_BRIDGE__ !== undefined,
    );
  });

  test('window.__SADEC_AGENT_BRIDGE__ có đủ 4 phương thức dạng hàm', async ({ page }) => {
    const kinds = await page.evaluate((methods) => {
      const bridge = (window as BridgeWindow).__SADEC_AGENT_BRIDGE__;
      return methods.map((name) => typeof (bridge as unknown as Record<string, unknown>)[name]);
    }, BRIDGE_METHODS);
    expect(kinds).toEqual(['function', 'function', 'function', 'function']);
  });

  test('verifyQrToken với token sai trả về null', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const bridge = (window as BridgeWindow).__SADEC_AGENT_BRIDGE__;
      return bridge ? await bridge.verifyQrToken('SDECQR.khong.hop.le') : 'no-bridge';
    });
    expect(result).toBeNull();
  });

  test('quoteBooking trả số nguyên VND và tiền cọc dương', async ({ page }) => {
    const quote = await page.evaluate(async () => {
      const bridge = (window as BridgeWindow).__SADEC_AGENT_BRIDGE__;
      if (!bridge) throw new Error('Thiếu bridge');
      const result = await bridge.listSupplyLots();
      if (result.status !== 'OK') throw new Error(`Danh mục không sẵn sàng: ${String(result.status)}`);
      const lot = result.lots[0];
      if (!lot) throw new Error('Không có lô nào để báo giá');
      return bridge.quoteBooking({ lotId: lot.id, quantity: 10 });
    });
    expect(Number.isInteger(quote.grossTotalVnd)).toBe(true);
    expect(quote.grossTotalVnd).toBeGreaterThan(0);
    expect(Number.isInteger(quote.depositRequiredVnd)).toBe(true);
    expect(quote.depositRequiredVnd).toBeGreaterThan(0);
  });

  test('proposeBooking với expectedRevision đúng hiện Agent Proposal HUD', async ({ page }) => {
    await page.evaluate(async () => {
      const bridge = (window as BridgeWindow).__SADEC_AGENT_BRIDGE__;
      if (!bridge) throw new Error('Thiếu bridge');
      const result = await bridge.listSupplyLots();
      if (result.status !== 'OK') throw new Error(`Danh mục không sẵn sàng: ${String(result.status)}`);
      // Propose the lot's own MOQ: a fixed quantity can be below a lot's MOQ and
      // be refused for that reason, which would make this test about seed data
      // rather than about the HUD.
      const lot =
        result.lots.find((l) => l.moq_units <= 10 && l.available_units >= l.moq_units) ??
        result.lots[0];
      if (!lot) throw new Error('Không có lô nào để đề xuất');
      await bridge.proposeBooking({
        lotId: lot.id,
        quantity: lot.moq_units,
        expectedRevision: lot.revision,
      });
    });
    const hud = page.locator('.agent-hud');
    await expect(hud).toBeVisible();
    await expect(hud).toContainText(/0\s?đ|ứng vốn/i);
    await expect(hud.getByRole('button')).toHaveCount(2);
  });
});

test.describe('Command Palette và JSON-LD View', () => {
  test('Ctrl/Cmd+K mở hộp thoại và Escape đóng lại', async ({ page }) => {
    await expectCommandPaletteToggles(page);
  });

  test('công tắc Agent JSON-LD View hiện dữ liệu schema.org trên lô đầu tiên', async ({
    page,
  }) => {
    await expectJsonLdViewOnFirstLot(page);
  });

});

/**
 * Đổi không gian làm việc theo danh sách membership máy chủ trả về.
 *
 * Danh tính dev local là nhân viên (`demo:sub:operator`) với ba membership:
 * ws-demo-a, ws-shop-q1, ws-shop-damsen. Bộ chuyển chỉ liệt kê đúng ba
 * không gian đó; không có nút nào dẫn tới một không gian máy chủ sẽ từ chối.
 */
test.describe('Đổi không gian làm việc', () => {
  test('bộ chuyển chỉ liệt kê membership của chính người dùng và đổi sau khi máy chủ xác nhận', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByText('Không gian: ws-demo-a')).toBeVisible();

    const switcher = page.getByRole('combobox', { name: 'Đổi vườn' });
    await expect(switcher).toBeVisible();
    const optionValues = await switcher.locator('option').evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value),
    );
    expect(optionValues.sort()).toEqual(['ws-demo-a', 'ws-shop-damsen', 'ws-shop-q1']);
    expect(optionValues).not.toContain('ws-demo-b');

    const confirmed = page.waitForResponse(
      (res) => res.url().includes('/api/session') && res.url().includes('workspace_id=ws-shop-q1'),
    );
    await switcher.selectOption('ws-shop-q1');
    const response = await confirmed;
    expect(response.status()).toBe(200);
    await expect(page.getByText('Không gian: ws-shop-q1')).toBeVisible();
    await expect(switcher).toHaveValue('ws-shop-q1');

    // Tải lại: lựa chọn được giữ vì máy chủ xác nhận lại, không phải vì trình duyệt nhớ.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('Không gian: ws-shop-q1')).toBeVisible();

    await switcher.selectOption('ws-demo-a');
    await expect(page.getByText('Không gian: ws-demo-a')).toBeVisible();
  });

  test('không gian đã lưu nhưng không còn quyền thì máy chủ trả về không gian hợp lệ và màn hình báo rõ', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('sadec_preferred_workspace_id', 'ws-demo-b');
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByText('Không gian: ws-demo-a')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Không còn quyền vào không gian' })).toBeVisible();
    await expect(page.getByText('Không gian: ws-demo-b')).toHaveCount(0);
  });
});

/**
 * Chuỗi đặt giữ thật: UI → API → D1 → UI đọc lại. Shop Quận 1 đặt MOQ của một
 * lô còn hàng; số còn lại trên thẻ lô phải giảm đúng bằng số đã đặt sau khi
 * danh sách được tải lại từ máy chủ.
 */
test.describe('Đặt giữ lô qua giao diện', () => {
  test('shop đặt giữ MOQ, nhận mã đơn và VietQR, tồn kho đọc lại giảm đúng', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByRole('combobox', { name: 'Đổi vườn' }).selectOption('ws-shop-q1');
    await expect(page.getByText('Không gian: ws-shop-q1')).toBeVisible();
    await page.getByRole('button', { name: 'Chợ Sỉ Hoa Kiểng B2B' }).click();

    // Chọn thẻ lô đầu tiên còn đặt được.
    const bookable = page.locator('.lot-card').filter({
      has: page.getByRole('button', { name: 'Đặt giữ lô ngay' }),
    });
    await expect(bookable.first()).toBeVisible();
    const card = bookable.first();
    const footer = (await card.locator('.lot-card__footer').textContent()) ?? '';
    const beforeMatch = /Còn:\s*(\d+)\s*\/\s*(\d+)/.exec(footer.replace(/\s+/g, ' '));
    expect(beforeMatch).not.toBeNull();
    const before = Number(beforeMatch?.[1]);
    const moqMatch = /MOQ:\s*(\d+)/.exec(((await card.textContent()) ?? '').replace(/\s+/g, ' '));
    const moq = Number(moqMatch?.[1]);
    expect(moq).toBeGreaterThan(0);
    const lotTitle = ((await card.locator('.lot-card__title').first().textContent()) ?? '').trim();

    await card.getByRole('button', { name: 'Đặt giữ lô ngay' }).click();
    const dialog = page.getByRole('dialog', { name: /Đặt Giữ Lô/ });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Tên Shop hoa tại TP.HCM').fill('Shop Hoa Tươi Quận 1 (E2E)');
    await dialog.getByLabel('Số điện thoại liên hệ').fill('0903123456');

    const created = page.waitForResponse(
      (res) => res.url().includes('/api/b2b/bookings/create') && res.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Xác nhận đặt giữ & Lấy mã VietQR' }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect(response.request().headers()['idempotency-key']).toMatch(/^ui-/);

    await expect(dialog.getByText('Đặt giữ lô thành công!')).toBeVisible();
    await expect(dialog.locator('.qr-voucher__code')).toContainText(/SDEC-BK-|bk-/i);
    // The local deployment has no receiving account configured, and the app must
    // say so rather than print an account number to transfer to. A configured
    // deployment renders the QR instead; that path is covered by the route tests
    // (test/b2b-routes.test.ts) and the VietQR unit tests.
    await expect(dialog.getByText('CHƯA CẤU HÌNH TÀI KHOẢN NHẬN CỌC')).toBeVisible();
    await expect(dialog.getByText('MÃ VIETQR BẢO CHỨNG CỌC', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/STK|Số tài khoản nhận/i)).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Hoàn tất & Quay lại' }).click();

    // Đọc lại từ máy chủ: thẻ cùng lô giảm đúng MOQ.
    const sameCard = page.locator('.lot-card').filter({ hasText: lotTitle }).first();
    await expect(sameCard.locator('.lot-card__footer')).toContainText(`Còn: ${before - moq}`);
  });
});

