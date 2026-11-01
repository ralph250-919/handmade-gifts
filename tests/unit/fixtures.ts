import type { Order, Product } from '../../backend/src/lib/types.js';

export function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    slug: 'mug',
    name: 'Speckled Mug',
    description: 'Wheel-thrown',
    priceCents: 3200,
    currency: 'usd',
    images: ['/images/products/mug.jpg'],
    stock: 5,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'cs_test_123',
    status: 'PENDING',
    items: [{ productId: 'p1', name: 'Speckled Mug', unitPriceCents: 3200, quantity: 2 }],
    subtotalCents: 6400,
    currency: 'usd',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
