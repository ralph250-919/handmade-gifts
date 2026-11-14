import { describe, expect, it } from 'vitest';
import { productInput, productUpdate, uniqueSlug } from '../../backend/src/handlers/adminProducts.js';
import { envInt } from '../../backend/src/lib/config.js';
import { toStripeSessionParams } from '../../backend/src/lib/checkout.js';
import { slugify } from '../../backend/src/lib/slug.js';
import { product } from './fixtures.js';

describe('product validation', () => {
  it('PUT keeps fields that were not sent (no POST defaults)', () => {
    expect(productUpdate.parse({ name: 'New', priceCents: 1200 })).toEqual({ name: 'New', priceCents: 1200 });
  });

  it('POST still fills in defaults', () => {
    expect(productInput.parse({ name: 'Mug', priceCents: 1200 })).toMatchObject({ description: '', images: [], stock: null, active: true });
  });

  it('accepts null to clear the category', () => {
    expect(productUpdate.parse({ category: null })).toEqual({ category: null });
  });

  it('caps prices at $10,000', () => {
    expect(productInput.safeParse({ name: 'x', priceCents: 1_000_000 }).success).toBe(true);
    expect(productInput.safeParse({ name: 'x', priceCents: 1_000_001 }).success).toBe(false);
  });
});

describe('uniqueSlug', () => {
  const taken = (...slugs: string[]) => async (s: string) => (slugs.includes(s) ? product({ id: `other-${s}`, slug: s }) : undefined);

  it('suffixes "item" for names with no Latin characters', async () => {
    expect(await uniqueSlug('手作りマグ', undefined, taken())).toBe('item');
    expect(await uniqueSlug('手作りマグ', undefined, taken('item'))).toBe('item-2');
    expect(await uniqueSlug('手作りマグ', undefined, taken('item', 'item-2'))).toBe('item-3');
  });

  it('keeps suffixed slugs within 80 characters', async () => {
    const long = 'a'.repeat(100);
    const first = await uniqueSlug(long, undefined, taken());
    const second = await uniqueSlug(long, undefined, taken(first));
    expect(second).toMatch(/-2$/);
    expect(second.length).toBeLessThanOrEqual(80);
  });

  it("doesn't treat a product's own slug as taken", async () => {
    expect(await uniqueSlug('mug', 'other-mug', taken('mug'))).toBe('mug');
  });
});

describe('slugify', () => {
  it('never ends in a hyphen after truncating', () => {
    const slug = slugify(`${'a'.repeat(79)} b`);
    expect(slug).toBe('a'.repeat(79));
  });
});

describe('envInt', () => {
  it('rejects values that are not whole numbers', () => {
    process.env.TEST_INT = '6OO';
    expect(() => envInt('TEST_INT', 1)).toThrow(/whole number/);
    process.env.TEST_INT = '600';
    expect(envInt('TEST_INT', 1)).toBe(600);
    delete process.env.TEST_INT;
    expect(envInt('TEST_INT', 1)).toBe(1);
  });
});

describe('toStripeSessionParams', () => {
  it('maps line items, shipping and redirect URLs', () => {
    const params = toStripeSessionParams({
      currency: 'usd',
      lineItems: [{ productId: 'p1', name: 'Mug', unitAmount: 3200, quantity: 2, imageUrl: 'https://shop.example/m.jpg' }],
      shippingCents: 0,
      allowedCountries: ['US', 'CA'],
      successUrl: 'https://shop.example/ok',
      cancelUrl: 'https://shop.example/cancel',
    });
    expect(params).toMatchObject({
      mode: 'payment',
      line_items: [{ quantity: 2, price_data: { currency: 'usd', unit_amount: 3200, product_data: { name: 'Mug', images: ['https://shop.example/m.jpg'], metadata: { productId: 'p1' } } } }],
      shipping_address_collection: { allowed_countries: ['US', 'CA'] },
      shipping_options: [{ shipping_rate_data: { display_name: 'Free shipping', fixed_amount: { amount: 0, currency: 'usd' } } }],
      success_url: 'https://shop.example/ok',
      cancel_url: 'https://shop.example/cancel',
    });
  });
});
