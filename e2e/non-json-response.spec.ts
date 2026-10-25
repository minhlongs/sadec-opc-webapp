import { expect, test } from '@playwright/test';

/**
 * A 200 whose body is not JSON reads as Vietnamese, never as a parser complaint.
 *
 * This is the deployment case, not a hypothetical. Cloudflare Access answers a
 * request that carries no accepted token with its own HTML login page, and it
 * answers it with a success status. The browser can therefore be handed a 200
 * and a page, and a bare `response.json()` throws a `SyntaxError` whose message
 * quotes the HTML in English — `Unexpected token '<', "<html>not "... is not
 * valid JSON`. That reaches the operator under a Vietnamese heading, so it reads
 * as a broken login rather than as a session that expired, which is the one
 * thing they can act on.
 *
 * The assertion is on the message the operator reads. It fails if the raw parser
 * text appears anywhere in the panel, because that is the regression.
 */
test('a success status with a non-JSON body explains itself in Vietnamese', async ({ page }) => {
  await page.route('**/api/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html>Access login page</html>',
    });
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  const panel = page.getByText('Không vào được làm việc');
  await expect(panel).toBeVisible();

  // The message is served by the Worker's own Vietnamese copy, and names the
  // expiry rather than the parse.
  await expect(page.getByText(/Máy chủ trả về nội dung không phải dữ liệu/)).toBeVisible();

  // The regression itself: a parser complaint must not reach the operator.
  const rendered = await page.locator('#root').innerText();
  expect(rendered, `raw parser text reached the panel: ${rendered}`).not.toMatch(
    /is not valid JSON|Unexpected token/i,
  );

  // The retry affordance survives, so the operator is not left at a dead end.
  await expect(page.getByRole('button', { name: 'Thử lại' })).toBeVisible();
});
