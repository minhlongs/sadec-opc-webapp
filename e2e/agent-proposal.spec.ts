import { expect, test, type Page } from '@playwright/test';

/**
 * The agent bridge's proposal path, through the real page.
 *
 * The product rule is "the agent proposes, the person confirms, and the
 * confirmation writes nothing the server would not have written". This file
 * proves what a unit test cannot:
 *
 * 1. A proposal is staged and shown in the HUD with its `expectedRevision`; no
 *    request is sent until the person clicks confirm.
 * 2. Confirming opens the booking form pre-filled and the booking is a normal
 *    POST carrying `Idempotency-Key` and `expected_revision`, so the server's
 *    authorization, validation and revision check still decide.
 * 3. A proposal whose lot moved under it is refused by the server
 *    (`revision_conflict`), the form re-reads the lot and keeps what was typed.
 * 4. A proposal naming a lot this catalog does not list is dropped with a
 *    message — the screen no longer invents a lot with made-up availability.
 * 5. Switching workspace clears the staged proposal.
 */

const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' };

interface LotView {
  id: string;
  lot_code: string;
  name: string;
  revision: string;
  moq_units: number;
  unit_price_vnd: number;
  deposit_rate_bps: number;
  available_units: number;
}

const HUD = { name: 'Đề xuất đặt giữ từ AI Agent Co-Pilot' } as const;

async function openMarketplace(page: Page, workspaceId = 'ws-shop-q1'): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('combobox', { name: 'Đổi vườn' }).selectOption(workspaceId);
  await expect(page.getByText(`Không gian: ${workspaceId}`)).toBeVisible();
  await page.getByRole('button', { name: 'Chợ Sỉ Hoa Kiểng B2B' }).click();
  await expect(page.locator('.lot-card').first()).toBeVisible();
}

async function firstBookableLot(page: Page, workspaceId = 'ws-shop-q1'): Promise<LotView> {
  const res = await page.request.get(`/api/b2b/lots?workspace_id=${workspaceId}`);
  expect(res.status()).toBe(200);
  const { lots } = (await res.json()) as { lots: LotView[] };
  // The suite starts from the seed (scripts/e2e-prepare.ts resets the demo
  // database), so a lot with enough stock for one MOQ always exists.
  const lot = lots.find((l) => l.available_units >= l.moq_units && l.available_units > 0);
  expect(lot).toBeDefined();
  return lot!;
}

async function stage(page: Page, lot: LotView, buyer = 'Vựa Hoa Agent (E2E)') {
  return page.evaluate(
    ({ id, revision, quantity, buyerName }) => {
      const bridge = window.__SADEC_AGENT_BRIDGE__;
      if (!bridge) throw new Error('agent bridge missing');
      return bridge.tools.proposeBooking({
        lotId: id,
        quantity,
        expectedRevision: revision,
        buyerShopName: buyerName,
        buyerContactPhone: '0909888777',
        destinationMarket: 'Chợ Đầm Sen',
        note: 'Đề xuất từ trợ lý AI',
      });
    },
    { id: lot.id, revision: lot.revision, quantity: lot.moq_units, buyerName: buyer },
  );
}

test.describe('Agent đề xuất — người dùng xác nhận', () => {
  test('đề xuất chỉ nằm trên HUD; chưa ghi gì tới khi xác nhận, rồi đơn mang expected_revision', async ({
    page,
  }) => {
    await openMarketplace(page);
    const lot = await firstBookableLot(page);

    const staged = await stage(page, lot);
    expect(staged.status).toBe('STAGED_FOR_HUMAN_CONFIRMATION');
    if (staged.status !== 'STAGED_FOR_HUMAN_CONFIRMATION') throw new Error('proposal was refused');
    expect(staged.requiresHumanClick).toBe(true);

    const hud = page.getByRole('region', HUD);
    await expect(hud).toBeVisible();
    await expect(hud.getByText(`expectedRevision: ${lot.revision}`)).toBeVisible();

    // Proposing is not booking: the lot's revision is untouched.
    const before = await page.request.get('/api/b2b/lots?workspace_id=ws-shop-q1');
    const beforeLots = ((await before.json()) as { lots: LotView[] }).lots;
    expect(beforeLots.find((l) => l.id === lot.id)?.revision).toBe(lot.revision);

    await hud.getByRole('button', { name: /Người dùng xác nhận/ }).click();
    const dialog = page.getByRole('dialog', { name: /Đặt Giữ Lô/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Tên Shop hoa tại TP.HCM')).toHaveValue('Vựa Hoa Agent (E2E)');
    await expect(dialog.getByLabel('Số điện thoại liên hệ')).toHaveValue('0909888777');

    const created = page.waitForResponse(
      (res) => res.url().includes('/api/b2b/bookings/create') && res.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Xác nhận đặt giữ & Lấy mã VietQR' }).click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    const sent = response.request().postDataJSON() as { lot_id: string; expected_revision: string | null };
    expect(sent.lot_id).toBe(lot.id);
    expect(sent.expected_revision).toBe(lot.revision);
    expect(response.request().headers()['idempotency-key']).toMatch(/^ui-/);
    await expect(dialog.getByText('Đặt giữ lô thành công!')).toBeVisible();
  });

  test('lô đổi tồn kho sau khi đề xuất: máy chủ từ chối revision_conflict, biểu mẫu giữ nội dung và tải lại lô', async ({
    page,
  }) => {
    await openMarketplace(page);
    const lot = await firstBookableLot(page);
    await stage(page, lot, 'Vựa Hoa Cũ (E2E)');
    const hud = page.getByRole('region', HUD);
    await expect(hud).toBeVisible();

    // Someone else books the same lot: the revision in the database moves while
    // this page still holds the old one.
    const other = await page.request.post('/api/b2b/bookings/create?workspace_id=ws-shop-q1', {
      headers: SAME_ORIGIN,
      data: {
        lot_id: lot.id,
        quantity: lot.moq_units,
        buyer_shop_name: 'Vựa Khác (E2E)',
        buyer_contact_phone: '0909555444',
        destination_market: 'Chợ Đầm Sen',
      },
    });
    expect(other.status(), await other.text()).toBe(201);

    await hud.getByRole('button', { name: /Người dùng xác nhận/ }).click();
    const dialog = page.getByRole('dialog', { name: /Đặt Giữ Lô/ });
    await expect(dialog).toBeVisible();

    const refused = page.waitForResponse(
      (res) => res.url().includes('/api/b2b/bookings/create') && res.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Xác nhận đặt giữ & Lấy mã VietQR' }).click();
    const response = await refused;
    expect(response.status()).toBe(409);

    await expect(dialog.getByText(/Dữ liệu lô đã được tải lại/)).toBeVisible();
    // What the person typed survives the refusal.
    await expect(dialog.getByLabel('Tên Shop hoa tại TP.HCM')).toHaveValue('Vựa Hoa Cũ (E2E)');
    await expect(dialog.getByText('Đặt giữ lô thành công!')).toHaveCount(0);
  });

  test('đề xuất cho lô không có trong danh mục bị hủy, không dựng lô giả và không mở biểu mẫu', async ({ page }) => {
    await openMarketplace(page);

    // A lot id the catalog does not hold. The bridge is fed it directly, which is
    // the situation after a listing is archived or withdrawn between the agent's
    // read and the person's click.
    const staged = await page.evaluate(() => {
      const bridge = window.__SADEC_AGENT_BRIDGE__;
      if (!bridge) throw new Error('agent bridge missing');
      bridge.syncLots([
        {
          id: 'lot-ghost-e2e',
          lot_code: 'SDEC-LOT-GHOST',
          nursery_workspace_id: 'ws-demo-a',
          nursery_name: 'Vườn đã thu hồi',
          hamlet_area: 'Tân Quy Đông',
          name: 'Lô đã thu hồi (E2E)',
          mode: 'WEEKLY_CATALOG',
          species: 'Test',
          grade: 'A',
          pot_diameter_cm: 30,
          height_cm: 50,
          canopy_cm: 40,
          bud_specification: '—',
          media_proof_url: '',
          unit: 'chậu',
          unit_price_vnd: 100000,
          deposit_rate_bps: 3000,
          moq_units: 10,
          total_units: 100,
          available_units: 100,
          cut_or_ship_date: '2026-11-05',
          qr_lot_token: '',
          status: 'PUBLISHED',
          created_at: '2026-10-01T00:00:00.000Z',
          updated_at: '2026-10-01T00:00:00.000Z',
        },
      ] as never);
      return bridge.tools.proposeBooking({
        lotId: 'lot-ghost-e2e',
        quantity: 10,
        expectedRevision: 'lot-ghost-e2e:u100:PUBLISHED:2026-10-01T00:00:00.000Z',
        buyerShopName: 'Vựa Ma (E2E)',
        buyerContactPhone: '0909000111',
        destinationMarket: 'Chợ lạ',
      });
    });
    expect(staged.status).toBe('STAGED_FOR_HUMAN_CONFIRMATION');

    const hud = page.getByRole('region', HUD);
    await expect(hud).toBeVisible();
    await hud.getByRole('button', { name: /Người dùng xác nhận/ }).click();

    await expect(
      page.getByText('Lô trong đề xuất của Agent không còn trong danh mục hiện tại', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Đặt Giữ Lô/ })).toHaveCount(0);
    await expect(page.getByRole('region', HUD)).toHaveCount(0);
  });

  test('đổi không gian làm việc thì đề xuất đang chờ bị xóa', async ({ page }) => {
    await openMarketplace(page);
    const lot = await firstBookableLot(page);
    await stage(page, lot);
    await expect(page.getByRole('region', HUD)).toBeVisible();

    await page.getByRole('combobox', { name: 'Đổi vườn' }).selectOption('ws-demo-a');
    await expect(page.getByText('Không gian: ws-demo-a')).toBeVisible();
    await page.getByRole('button', { name: 'Chợ Sỉ Hoa Kiểng B2B' }).click();
    await expect(page.locator('.lot-card').first()).toBeVisible();
    await expect(page.getByRole('region', HUD)).toHaveCount(0);
  });
});
