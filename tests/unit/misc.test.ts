import { describe, expect, it } from 'vitest';
import { orderConfirmationEmail } from '../../backend/src/lib/email.js';
import { buildCatalogCsv, csvEscape } from '../../backend/src/lib/feed.js';
import { canTransition, formatMoney } from '../../backend/src/lib/orders.js';
import { slugify } from '../../backend/src/lib/slug.js';
import { order, product } from './fixtures.js';

describe('catalog feed (Instagram / Meta Commerce)', () => {
  it('outputs required columns with absolute URLs and skips hidden/photo-less products', () => {
    const csv = buildCatalogCsv(
      [product(), product({ id: 'p2', active: false }), product({ id: 'p3', images: [] }), product({ id: 'p4', name: 'Vase, "tall"', stock: 0 })],
      'https://shop.example',
      'Test Shop',
    );
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('id,title,description,availability,condition,price,link,image_link,additional_image_link,brand,product_type');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('32.00 USD');
    expect(lines[1]).toContain('https://shop.example/images/products/mug.jpg');
    expect(lines[2]).toContain('"Vase, ""tall"""');
    expect(lines[2]).toContain('out of stock');
  });

  it('escapes CSV values', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
  });
});

describe('order rules', () => {
  it('only allows forward transitions', () => {
    expect(canTransition('PENDING', 'PAID')).toBe(true);
    expect(canTransition('PAID', 'SHIPPED')).toBe(true);
    expect(canTransition('SHIPPED', 'PAID')).toBe(false);
    expect(canTransition('EXPIRED', 'PAID')).toBe(false);
  });

  it('formats money', () => {
    expect(formatMoney(3200, 'usd')).toBe('$32.00');
  });
});

describe('emails', () => {
  it('escapes customer-provided text in HTML', () => {
    const msg = orderConfirmationEmail(order({ customerEmail: 'a@b.c', customerName: '<script>x</script>', totalCents: 7000 }), 'Shop');
    expect(msg.html).not.toContain('<script>');
    expect(msg.text).toContain('$70.00');
  });
});

describe('slugify', () => {
  it('makes URL-safe slugs', () => {
    expect(slugify('  Crème Brûlée Candle (Large)! ')).toBe('creme-brulee-candle-large');
  });
});
