import { expect, test } from '@playwright/test';

/**
 * The same product on two lines renders two rows in the saved table.
 *
 * The schema deliberately allows it: `quoteLineSchema` limits the array to 100
 * lines and says nothing about distinct products, and a nursery quote can
 * legitimately list the same pot twice at different sizes or finish. The saved
 * table keyed each row on `product_id`, so the second line collided — React
 * warns that rows "may be duplicated and/or omitted", and the operator's priced
 * quote could lose a line without the preview disagreeing, since the preview
 * total was always right.
 *
 * This is the one case where React's own warning is the defect report, so the
 * test fails on that console message rather than only on the row count: a
 * duplicate key is the cause, and a missing row is only one of its symptoms.
 */
test('the same product on two lines renders both rows the server priced', async ({ page }, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  const customerId = ['cu-a-01', 'cu-a-02', 'cu-a-03'][testInfo.workerIndex] ?? 'cu-a-01';
  const reference = `BG-DUP-${customerId}`;

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#customer')).toBeVisible();

  await page.locator('#customer').selectOption(customerId);
  await page.locator('#reference').fill(reference);

  await page.locator('#product-0').selectOption('pd-a-01');
  await page.locator('#quantity-0').fill('2');

  await page.getByRole('button', { name: 'Thêm dòng' }).click();
  await page.locator('#product-1').selectOption('pd-a-01');
  await page.locator('#quantity-1').fill('3');

  // The preview prices 2 + 3 = 5 x 180.000 = 900.000 while the form is open, and
  // is labelled `Dự kiến` because it is prospective. It is asserted only to show
  // the form accepted two lines, not as the total that counts — that one comes
  // from the save below. The unit is its own element, so the assertion reads the
  // whole line rather than the currency fragment.
  const previewTotal = page.locator('.money--total');
  await expect(previewTotal).toContainText('Dự kiến:');
  await expect(previewTotal).toContainText('900.000');

  await page.getByRole('button', { name: 'Lưu báo giá' }).click();

  const savedPanel = page.locator('section', { has: page.locator('#saved-heading') });
  await expect(savedPanel.getByText(`Đã lưu báo giá ${reference}`)).toBeVisible();

  // Both rows, read from the table the operator sees. Two rows named pd-a-01 is
  // the assertion: keyed on the product, the second is dropped or duplicated.
  const savedRows = savedPanel.locator('tbody tr', { hasText: 'Cau vàng' });
  const rowCount = await savedRows.count();
  expect(rowCount, `expected 2 rows for 2 saved lines, found ${rowCount}`).toBe(2);

  await expect(savedPanel).toContainText('900.000 đ');

  // The draft list is re-read after the save, so the row proving the write
  // reached D1 carries both lines rather than the last one.
  const draftsPanel = page.locator('section', { has: page.locator('#drafts-heading') });
  await expect(draftsPanel.locator('tr', { hasText: reference })).toContainText('900.000 đ');

  await expect(page.getByText('Không lưu được báo giá')).toHaveCount(0);
  expect(failures, `console errors: ${failures.join(' | ')}`).toEqual([]);
});
