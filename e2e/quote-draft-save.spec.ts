import { expect, test } from '@playwright/test';

/**
 * The operator flow, driven through a real browser at both mandatory widths.
 *
 * This is the assertion that the phase's central claim stands on: an operator
 * composes a quote draft in the browser, saves it, and reads back a total the
 * **server** computed. The proof has to come from the browser rather than from
 * a unit test, because every defect that made a deployment refuse this same
 * flow while all 145 unit tests passed was invisible to a `Request` object a
 * test constructs by hand — a header a browser will not send, a verifier only
 * the test fills in, a database binding the generated deploy config drops.
 * Those are properties of the browser and of the built artifact, so the check
 * has to run where both exist.
 *
 * The customer is chosen by worker. The schema deliberately holds **one** live
 * draft per customer per workspace — two operators composing the same quote in
 * parallel is exactly the duplicate-quote bug the unique index prevents — so a
 * test that saved twice against one customer would update that draft's reference
 * rather than write a second row. That is not a defect to work around; it is the
 * business rule, and the test's identity has to follow it. A reference made
 * unique per worker still fails here, because the reference is a label the save
 * overwrites, not the key that selects the row.
 */
test('an operator composes a quote draft, saves it, and reads the server-computed total', async ({
  page,
  viewport,
}, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  // One seeded customer per project/worker, so the two projects save into different
  // drafts and each re-read asserts a write its own worker performed.
  const customerId =
    testInfo.project.name === 'desktop-1440'
      ? 'cu-a-02'
      : (['cu-a-01', 'cu-a-03'][testInfo.workerIndex % 2] ?? 'cu-a-01');
  const reference = `BG-BROWSER-${customerId}`;

  await page.goto('/', { waitUntil: 'networkidle' });

  // The form only exists once the session resolves, so this waits for the
  // chokepoint to have answered rather than for a timeout.
  await expect(page.locator('#customer')).toBeVisible();

  await page.locator('#customer').selectOption(customerId);
  await page.locator('#product-0').selectOption('pd-a-01');
  await page.locator('#quantity-0').fill('2');
  await page.locator('#reference').fill(reference);

  await page.getByRole('button', { name: 'Lưu báo giá' }).click();

  // pd-a-01 is seeded at 180000 in ws-demo-a, so 2 x 180000 = 360000. The value
  // asserted is the one the save returns, not the one the form previewed: §7
  // requires the server to price every line from its own catalog row, so a
  // correct-looking client total would not distinguish a real save from a form
  // echoing itself.
  const savedPanel = page.locator('section', { has: page.locator('#saved-heading') });
  await expect(savedPanel.getByText(`Đã lưu báo giá ${reference}`)).toBeVisible();
  await expect(savedPanel.getByText('360.000 đ')).toBeVisible();

  // The draft list is re-read after the save, so the row proving the write
  // reached D1 rather than the response alone.
  const draftsPanel = page.locator('section', { has: page.locator('#drafts-heading') });
  const savedRow = draftsPanel.locator('tr', { hasText: reference });
  await expect(savedRow).toBeVisible();
  await expect(savedRow).toContainText('360.000 đ');

  // A refusal renders as an error panel inside the form. Asserting its absence
  // here means a 403 would fail this test as a refused save rather than pass
  // silently with the panel never drawn.
  await expect(page.getByText('Không lưu được báo giá')).toHaveCount(0);
  expect(failures).toEqual([]);

  console.log(`saved ${reference} and read it back at ${viewport?.width ?? '?'}px`);
});
