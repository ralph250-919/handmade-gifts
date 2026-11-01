import { describe, expect, it } from 'vitest';
import { parseCart, priceCart, shippingCentsFor } from '../../backend/src/lib/cart.js';
import { UserFacingError } from '../../backend/src/lib/errors.js';
import { product } from './fixtures.js';

const catalog = (...ps: ReturnType<typeof product>[]) => new Map(ps.map((p) => [p.id, p]));

describe('parseCart', () => {
  it('merges duplicate lines', () => {
    expect(parseCart({ items: [{ productId: 'a', quantity: 1 }, { productId: 'a', quantity: 2 }] })).toEqual({
      items: [{ productId: 'a', quantity: 3 }],
    });
  });

  it.each([
    [{}, 'missing items'],
    [{ items: [] }, 'empty cart'],
    [{ items: [{ productId: 'a', quantity: 0 }] }, 'zero quantity'],
    [{ items: [{ productId: 'a', quantity: 1.5 }] }, 'fractional quantity'],
    [{ items: [{ productId: 'a', quantity: 999 }] }, 'huge quantity'],
  ])('rejects %j (%s)', (body, _reason) => {
    expect(() => parseCart(body)).toThrow(UserFacingError);
  });
});

describe('priceCart', () => {
  it('uses server prices, never client prices', () => {
    const cart = parseCart({ items: [{ productId: 'p1', quantity: 2, priceCents: 1 }] });
    const priced = priceCart(cart, catalog(product()));
    expect(priced.subtotalCents).toBe(6400);
    expect(priced.items[0]).toMatchObject({ unitPriceCents: 3200, name: 'Speckled Mug' });
  });

  it('rejects unknown or hidden products', () => {
    const cart = parseCart({ items: [{ productId: 'p1', quantity: 1 }] });
    expect(() => priceCart(cart, new Map())).toThrow(/no longer available/);
    expect(() => priceCart(cart, catalog(product({ active: false })))).toThrow(/no longer available/);
  });

  it('enforces stock with a friendly message', () => {
    const cart = parseCart({ items: [{ productId: 'p1', quantity: 3 }] });
    expect(() => priceCart(cart, catalog(product({ stock: 2 })))).toThrow('Only 2 of "Speckled Mug" left in stock.');
    expect(() => priceCart(cart, catalog(product({ stock: 0 })))).toThrow(/sold out/);
  });

  it('allows any quantity of made-to-order items', () => {
    const cart = parseCart({ items: [{ productId: 'p1', quantity: 10 }] });
    expect(priceCart(cart, catalog(product({ stock: null }))).subtotalCents).toBe(32000);
  });

  it('rejects mixed currencies', () => {
    const cart = parseCart({ items: [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }] });
    expect(() => priceCart(cart, catalog(product(), product({ id: 'p2', currency: 'eur' })))).toThrow(/currencies/);
  });
});

describe('shippingCentsFor', () => {
  it('applies free shipping threshold', () => {
    expect(shippingCentsFor(5000, 600, 7500)).toBe(600);
    expect(shippingCentsFor(7500, 600, 7500)).toBe(0);
    expect(shippingCentsFor(99999, 600, 0)).toBe(600);
  });
});
