import { expect, test } from '@playwright/test';

const local = !process.env.BASE_URL;

test('storefront loads products and has no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('product-grid').locator('.card').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('product page can add to cart', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('product-grid').locator('.card').first().click();
  await page.getByTestId('add-to-cart').click();
  await expect(page.locator('[data-cart-count]')).toHaveText('1');
});

test('full purchase: cart → checkout → paid order in admin → shipped', async ({ page }) => {
  test.skip(!local, 'Uses the simulated Stripe page of the local dev server');
  await page.goto('/product.html?slug=speckled-stoneware-mug');
  await page.locator('[data-step="1"]').click();
  await page.getByTestId('add-to-cart').click();
  await page.goto('/cart.html');
  await expect(page.locator('.summary')).toContainText('$64.00');
  await page.getByTestId('checkout').click();
  await page.getByTestId('fake-pay').click();
  await expect(page).toHaveURL(/success\.html/);
  await expect(page.locator('[data-cart-count]')).toHaveText('0');
  const orderRef = new URL(page.url()).searchParams.get('session_id')!.slice(-8).toUpperCase();

  await page.goto('/admin/');
  const order = page.locator('.order').filter({ hasText: `#${orderRef}` });
  await expect(order).toContainText('$70.00');
  await order.getByPlaceholder('Tracking # (optional)').fill('1Z999');
  await order.getByRole('button', { name: /Mark shipped/ }).click();
  await expect(page.locator('#status')).toContainText('Marked as shipped');
});

test('cart rejects quantities above stock with a clear message', async ({ page }) => {
  test.skip(!local, 'Local only');
  await page.goto('/product.html?slug=macrame-wall-hanging');
  await page.getByTestId('add-to-cart').click();
  await page.goto('/product.html?slug=macrame-wall-hanging');
  await page.getByTestId('add-to-cart').click();
  await page.goto('/product.html?slug=macrame-wall-hanging');
  await page.getByTestId('add-to-cart').click();
  await page.goto('/cart.html');
  await page.getByTestId('checkout').click();
  await expect(page.locator('#status')).toContainText(/left in stock/);
});
