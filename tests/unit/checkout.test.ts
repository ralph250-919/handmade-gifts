import { describe, expect, it, vi } from 'vitest';
import { startCheckout, type CheckoutDeps } from '../../backend/src/lib/checkout.js';
import { product } from './fixtures.js';

const settings = {
  siteUrl: 'https://shop.example',
  shopName: 'Test Shop',
  allowedCountries: ['US', 'CA'],
  shippingStandardCents: 600,
  freeShippingOverCents: 7500,
};

function deps(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps {
  return {
    getProductsByIds: vi.fn(async () => new Map([['p1', product()]])),
    createSession: vi.fn(async () => ({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' })),
    createPendingOrder: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('startCheckout', () => {
  it('creates a Stripe session with server-side prices and records a pending order', async () => {
    const d = deps();
    const res = await startCheckout(d, { items: [{ productId: 'p1', quantity: 2 }] }, settings);

    expect(res.url).toContain('checkout.stripe.com');
    expect(d.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'usd',
        shippingCents: 600,
        allowedCountries: ['US', 'CA'],
        successUrl: 'https://shop.example/success.html?session_id={CHECKOUT_SESSION_ID}',
        lineItems: [expect.objectContaining({ unitAmount: 3200, quantity: 2, imageUrl: 'https://shop.example/images/products/mug.jpg' })],
      }),
    );
    expect(d.createPendingOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cs_test_abc', status: 'PENDING', subtotalCents: 6400, shippingCents: 600 }),
    );
  });

  it('gives free shipping over the threshold', async () => {
    const d = deps();
    await startCheckout(d, { items: [{ productId: 'p1', quantity: 3 }] }, settings);
    expect(d.createSession).toHaveBeenCalledWith(expect.objectContaining({ shippingCents: 0 }));
  });

  it('does not create a session when the cart is invalid', async () => {
    const d = deps({ getProductsByIds: vi.fn(async () => new Map([['p1', product({ stock: 0 })]])) });
    await expect(startCheckout(d, { items: [{ productId: 'p1', quantity: 1 }] }, settings)).rejects.toThrow(/sold out/);
    expect(d.createSession).not.toHaveBeenCalled();
    expect(d.createPendingOrder).not.toHaveBeenCalled();
  });
});
