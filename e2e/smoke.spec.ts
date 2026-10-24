import { expect, test } from '@playwright/test';

/**
 * Placeholder smoke test for phase 0.
 *
 * §15 cases 1, 2 and 16 need a real journey, and the journey needs the screens
 * from phase 1. This exists so `pnpm test:e2e` proves the browser runs at both
 * mandatory sizes from §5 now, and so a later phase adds journeys beside a file
 * that already works rather than discovering the harness is broken.
 */
test('the app shell reaches the browser at both mandatory widths', async ({ page, viewport }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  // The phase-0 scaffold renders one line, which is enough to prove the whole
  // chain from browser to served bundle works.
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(errors).toEqual([]);

  // Report the width this project ran at, so a bare "pass" cannot hide a run at
  // only one of the two sizes.
  console.log(`rendered at ${viewport?.width ?? '?'}px`);
});
