import { expect, test } from '@playwright/test';

/**
 * Failures written to look like the ones a real suite produces, so the demo shows
 * the plugin reasoning about a stale locator, a race condition and a bad assertion.
 */

test('shows the order total @intentional-failure', async ({ page }) => {
  await page.setContent('<div id="cart"><span class="total">€ 42.00</span></div>');
  await expect(page.locator('.order-total')).toHaveText('€ 42.00', { timeout: 2000 });
});

test('renders every cart row @intentional-failure', async ({ page }) => {
  await page.setContent(`
    <ul id="rows"></ul>
    <script>
      setTimeout(() => {
        document.getElementById('rows').innerHTML = '<li>one</li><li>two</li>';
      }, 3000);
    </script>
  `);
  await page.waitForTimeout(500);
  await expect(page.locator('#rows li')).toHaveCount(2, { timeout: 1000 });
});

test('computes the discounted price @intentional-failure', () => {
  const price = 100;
  const discounted = price - price * 0.2;
  expect(discounted).toBe('80');
});

test('keeps the cart empty by default', async ({ page }) => {
  await page.setContent('<ul id="rows"></ul>');
  await expect(page.locator('#rows li')).toHaveCount(0);
});
