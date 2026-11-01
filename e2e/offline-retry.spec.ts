import { expect, test } from '@playwright/test';

/**
 * A dropped connection leaves the operator a way back in, not a dead screen.
 *
 * §5 asks for the offline state to keep what is on screen, and it says what the
 * operator is told. It does not say what they can *do* about it, which is where
 * this case lives: the offline banner told them to "thử lại khi có mạng" with no
 * button anywhere on screen, so the only action available was knowing to reload
 * the browser tab. The error state directly above it did render "Thử lại", which
 * made the difference visible — two failure states side by side, one actionable
 * and one not.
 *
 * The recovery is asserted as well as the banner, because the flag that raises
 * the banner has to be cleared when the session finally resolves. Without that
 * the first successful retry would fetch the session, render the app, and leave
 * the offline banner standing over it.
 */
test('a dropped connection offers a retry that restores the session', async ({ page }) => {
  let failing = true;
  await page.route('**/api/session', async (route) => {
    if (failing) await route.abort('failed');
    else await route.continue();
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  const banner = page.getByText('Mất kết nối');
  await expect(banner).toBeVisible();

  // The banner is `role="status"` with `aria-live="polite"`, so the operator is
  // told the connection is gone without the content being replaced.
  const retry = page.getByRole('button', { name: 'Thử lại' });
  await expect(retry).toBeVisible();

  // The form is not dismissed while the connection is gone: §5 requires a form
  // to survive a failed load, so the operator comes back to what they typed.
  await expect(page.locator('#root')).not.toBeEmpty();

  failing = false;
  await retry.click();

  // The session resolves and the app is served, which is the only thing that
  // makes the retry worth clicking.
  await expect(page.locator('#customer')).toBeVisible();

  // And the banner goes, rather than lingering over a working app.
  await expect(banner).toHaveCount(0);
});
