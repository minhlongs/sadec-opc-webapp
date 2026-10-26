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
}

interface BridgeQuote {
  grossTotalVnd: number;
  depositRequiredVnd: number;
}

interface AgentBridge {
  listSupplyLots: () => Promise<BridgeLot[]>;
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
      const lots = await bridge.listSupplyLots();
      const lot = lots[0];
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
      const lots = await bridge.listSupplyLots();
      const lot = lots[0];
      if (!lot) throw new Error('Không có lô nào để đề xuất');
      await bridge.proposeBooking({
        lotId: lot.id,
        quantity: 10,
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

