import type { Context } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpEvent } from '../../backend/src/lib/http.js';
import type { Product } from '../../backend/src/lib/types.js';
import { product } from './fixtures.js';

// In-memory product store with the same optimistic-locking rule as db.putProductIfUnchanged.
const store = new Map<string, Product>();
vi.mock('../../backend/src/lib/db.js', () => ({
  getProduct: vi.fn(async (id: string) => structuredClone(store.get(id))),
  getProductBySlug: vi.fn(async (slug: string) => [...store.values()].find((p) => p.slug === slug)),
  putProductIfUnchanged: vi.fn(async (p: Product, expectedUpdatedAt: string) => {
    if (store.get(p.id)?.updatedAt !== expectedUpdatedAt) return false;
    store.set(p.id, structuredClone(p));
    return true;
  }),
}));

const { handler } = await import('../../backend/src/handlers/adminProducts.js');
const db = await import('../../backend/src/lib/db.js');

const put = async (body: Record<string, unknown>) => {
  const event = {
    routeKey: 'PUT /api/admin/products/{id}',
    pathParameters: { id: 'p1' },
    requestContext: { http: { method: 'PUT' }, requestId: 'r1' },
    headers: {},
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as HttpEvent;
  const res = await handler(event, { functionName: 'test' } as Context);
  return { status: res.statusCode, body: JSON.parse(String(res.body)) };
};

/** What the admin form sends: the product as loaded, with some edits, plus the stock it loaded. */
const form = (edits: Record<string, unknown> = {}, baseStock: number | null = 5) => ({
  name: 'Speckled Mug',
  description: 'Wheel-thrown',
  priceCents: 3200,
  images: ['/images/products/mug.jpg'],
  stock: 5,
  active: true,
  baseStock,
  ...edits,
});

/** A customer checks out 2 mugs while the admin has the form open. */
const sale = () => {
  const p = store.get('p1')!;
  store.set('p1', { ...p, stock: p.stock! - 2, updatedAt: '2026-01-02T00:00:00.000Z' });
};

describe('PUT /api/admin/products/{id}', () => {
  beforeEach(() => {
    store.clear();
    store.set('p1', product());
    vi.mocked(db.putProductIfUnchanged).mockClear();
  });

  it('keeps stock changed by a sale when the admin only edited other fields', async () => {
    sale();
    const res = await put(form({ name: 'Speckled Mug (blue)' }));
    expect(res.status).toBe(200);
    expect(store.get('p1')).toMatchObject({ name: 'Speckled Mug (blue)', stock: 3 });
  });

  it('refuses to overwrite stock that a sale changed while the admin was editing it', async () => {
    sale();
    const res = await put(form({ stock: 10 }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'STOCK_CHANGED', error: expect.stringContaining('changed to 3') });
    expect(store.get('p1')!.stock).toBe(3);
  });

  it('saves a stock change when nothing else changed it', async () => {
    const res = await put(form({ stock: 10 }));
    expect(res.status).toBe(200);
    expect(store.get('p1')!.stock).toBe(10);
  });

  it('lets the admin switch an item to made to order', async () => {
    const res = await put(form({ stock: null }));
    expect(res.status).toBe(200);
    expect(store.get('p1')!.stock).toBeNull();
  });

  it('retries when a sale lands between reading and saving the product', async () => {
    vi.mocked(db.putProductIfUnchanged).mockImplementationOnce(async () => {
      sale();
      return false;
    });
    const res = await put(form({ name: 'Renamed' }));
    expect(res.status).toBe(200);
    expect(db.putProductIfUnchanged).toHaveBeenCalledTimes(2);
    expect(store.get('p1')).toMatchObject({ name: 'Renamed', stock: 3 });
  });

  it('requires baseStock on updates', async () => {
    const { baseStock: _, ...withoutBase } = form();
    expect((await put(withoutBase)).status).toBe(400);
  });
});
