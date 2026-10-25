import { expect, test } from '@playwright/test';

/**
 * The shell reaches a real browser at both mandatory widths.
 *
 * §15 cases 1, 2 and 16 need a full journey, which belongs beside the screens
 * that own it. This test is the harness check underneath those: it proves the
 * React app mounts through the served bundle with no console error, at both
 * mandatory sizes from §5, so a later journey starts from a working browser
 * rather than discovering the harness is broken.
 */
test('the app shell reaches the browser at both mandatory widths', async ({ page, viewport }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  // A non-empty root proves the whole chain from served bundle to mounted
  // component works. The console-error assertion above is what stops this from
  // passing while a screen throws on mount.
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(errors).toEqual([]);

  // Report the width this project ran at, so a bare "pass" cannot hide a run at
  // only one of the two sizes.
  console.log(`rendered at ${viewport?.width ?? '?'}px`);
});
