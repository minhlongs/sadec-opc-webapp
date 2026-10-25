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

  // Switch to Hub Dispatch tab
  await page.getByRole('button', { name: 'Điều Phối Hub Sa Đéc' }).click();
  await expect(page.getByText('Điều Phối Gom Hàng & Cross-docking Hub Sa Đéc')).toBeVisible();

  // Switch to Inspection & Settlement tab
  await page.getByRole('button', { name: 'Nghiệm Thu & Đối Soát' }).click();
  await expect(page.getByText('Trạm Nghiệm Thu & Đối Soát Tự Động tại Shop TP.HCM')).toBeVisible();

  expect(errors).toEqual([]);
  console.log(`verified B2B tabs at ${viewport?.width ?? '?'}px`);
});
