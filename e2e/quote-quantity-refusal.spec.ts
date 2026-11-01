import { expect, test, type Locator } from '@playwright/test';

/**
 * A quantity the server refuses is shown to the operator, not silently reverted.
 *
 * `quoteLineSchema` takes a positive integer no greater than 100000. The form is
 * the only place that number is entered, so it is the only place it can be
 * refused — and how it refuses is what this test pins down. Two behaviours look
 * identical in a screenshot and are not the same thing:
 *
 *   1. The field snaps back to the last accepted value. The operator types `1.5`,
 *      the field keeps showing `1.5`, and what gets saved is `1`. Nothing on
 *      screen says so. A quantity nobody entered is charged to a customer.
 *   2. The typed value stays on screen, the line is not submitted, and a sentence
 *      names the line and the reason. The save is blocked until it is corrected.
 *
 * The first is the defect. The commit that caused it set the controlled numeric
 * field from `Number(value)`, which is a category-level control, so an invalid
 * edit went to the committed state while the draft kept the text.
 *
 * The file's hint also carries everything else the form needs from the operator,
 * so the assertion locates the hint by the text that names the line rather than
 * by a class shared with the product table.
 */

/** Types into a field, replacing what is there, the way an operator edits. */
async function retype(field: Locator, text: string) {
  await field.click();
  await field.press('ControlOrMeta+a');
  await field.pressSequentially(text);
}

test('a fractional quantity is kept on screen, named in a hint, and never saved', async ({
  page,
}, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  const customerId = testInfo.project.name === 'mobile-390' ? 'cu-a-05' : 'cu-a-06';

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#customer')).toBeVisible();

  await page.locator('#customer').selectOption(customerId);
  await page.locator('#reference').fill('BG-QTY-FRACTION');
  await page.locator('#product-0').selectOption('pd-a-01');

  const quantity = page.locator('#quantity-0');
  await retype(quantity, '1.5');

  // What the operator typed is still what they see. A field that replaced this
  // with `1` is the silent revert this test exists to catch.
  await expect(quantity).toHaveValue('1.5');

  // The refusal is named, on the line it belongs to, with the rejected value in
  // it — so the operator can see what was refused rather than guess why saving
  // does nothing.
  await expect(
    page.getByText('Số lượng ở dòng 1 phải là số nguyên, không phải 1.5.'),
  ).toBeVisible();

  // The save is blocked while the quantity is unacceptable. A disabled button
  // alone is not the guard §5 asks for, so the label beside it states the reason.
  await expect(page.getByRole('button', { name: 'Lưu báo giá' })).toBeDisabled();

  // A quantity that is not a whole number is a mistake, so it survives a blur.
  // Only a partial number (`12e`) is dropped, because that is not a quantity at
  // all — and dropping a fraction here would be the revert again.
  await quantity.blur();
  await expect(quantity).toHaveValue('1.5');

  // Correcting it puts the flow back on: the field takes the whole number, the
  // hint clears, and the save succeeds with the price the server computed for
  // the number that was actually entered (3 x 180.000 = 540.000).
  await retype(quantity, '3');
  await expect(
    page.getByText('Số lượng ở dòng 1 phải là số nguyên, không phải 1.5.'),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lưu báo giá' })).toBeEnabled();

  await page.getByRole('button', { name: 'Lưu báo giá' }).click();
  const savedPanel = page.locator('section', { has: page.locator('#saved-heading') });
  await expect(savedPanel.getByText('Đã lưu báo giá BG-QTY-FRACTION')).toBeVisible();
  await expect(savedPanel).toContainText('540.000 đ');

  // The refusal never wiped the form: §5 requires a form to survive everything
  // that is not a successful save, so the customer and reference the operator
  // chose are still there after the save that followed the refusal.
  await expect(page.locator('#customer')).toHaveValue(customerId);
  await expect(page.locator('#reference')).toHaveValue('BG-QTY-FRACTION');
  await expect(page.getByText('Không lưu được báo giá')).toHaveCount(0);
  expect(failures, `console errors: ${failures.join(' | ')}`).toEqual([]);
});

test('a quantity above the ceiling is refused by name, not swallowed', async ({ page }, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  const customerId = testInfo.project.name === 'mobile-390' ? 'cu-a-05' : 'cu-a-06';

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#customer')).toBeVisible();

  await page.locator('#customer').selectOption(customerId);
  await page.locator('#reference').fill('BG-QTY-CEILING');
  await page.locator('#product-0').selectOption('pd-a-01');

  const quantity = page.locator('#quantity-0');
  await retype(quantity, '200000');

  // The ceiling in the message is the same constant the server enforces, so a
  // hint that named a different limit would be a hint the server disagrees with.
  await expect(
    page.getByText('Số lượng ở dòng 1 phải lớn hơn 0 và không quá 100000.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lưu báo giá' })).toBeDisabled();

  // The over-ceiling number stays on screen too. Dropping it would leave the
  // operator believing they typed a quantity the system accepted.
  await expect(quantity).toHaveValue('200000');

  // The second line is refused on its own, so the hint names the line the bad
  // quantity is on rather than pointing at line 1 and correcting the wrong field.
  await page.getByRole('button', { name: 'Thêm dòng' }).click();
  await page.locator('#product-1').selectOption('pd-a-01');
  await retype(page.locator('#quantity-0'), '4');
  await retype(page.locator('#quantity-1'), '0');

  await expect(page.getByText('Số lượng ở dòng 2 phải lớn hơn 0 và không quá 100000.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lưu báo giá' })).toBeDisabled();

  // With both lines acceptable the same form saves, proving the refusal was
  // about the quantity and not about the line or the product.
  await retype(page.locator('#quantity-1'), '5');
  await expect(page.getByRole('button', { name: 'Lưu báo giá' })).toBeEnabled();

  await expect(failures, `console errors: ${failures.join(' | ')}`).toEqual([]);
});
