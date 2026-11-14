import { describe, expect, it, vi } from 'vitest';
import { handleCheckoutEvent, type CheckoutSessionInfo, type FulfillmentDeps } from '../../backend/src/lib/fulfillment.js';
import type { Order } from '../../backend/src/lib/types.js';
import { order } from './fixtures.js';

const settings = { shopName: 'Test Shop', ownerEmail: 'owner@shop.example', siteUrl: 'https://shop.example' };

const session = (o: Partial<CheckoutSessionInfo> = {}): CheckoutSessionInfo => ({
  id: 'cs_test_123',
  paymentStatus: 'paid',
  amountTotal: 7000,
  shippingCents: 600,
  customerEmail: 'buyer@example.com',
  customerName: 'Ada Buyer',
  shippingAddress: { name: 'Ada Buyer', line1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US' },
  ...o,
});

/** In-memory fake of the order and product stores with the same conditional semantics as DynamoDB. */
function fakeDeps(initial: Order[] = [order()], stock: Record<string, number | null> = { p1: 5 }) {
  const orders = new Map(initial.map((o) => [o.id, { ...o }]));
  const products = new Map(Object.entries(stock));
  const metrics: string[] = [];
  const deps: FulfillmentDeps = {
    transitionOrder: vi.fn(async (id, from, to, fields) => {
      const o = orders.get(id);
      if (!o || !from.includes(o.status)) return undefined;
      Object.assign(o, fields, { status: to });
      return { ...o };
    }),
    getOrder: vi.fn(async (id) => {
      const o = orders.get(id);
      return o && { ...o };
    }),
    reserveStock: vi.fn(async (orderId, productId, quantity) => {
      const o = orders.get(orderId)!;
      if (!products.has(productId)) return 'missing' as const;
      if (o.stockHandled?.includes(productId)) return 'already-handled' as const;
      const left = products.get(productId)!;
      if (left !== null && left < quantity) return 'insufficient' as const;
      if (left !== null) products.set(productId, left - quantity);
      o.stockHandled = [...(o.stockHandled ?? []), productId];
      return 'reserved' as const;
    }),
    flagStockIssue: vi.fn(async (orderId, productId, issue) => {
      const o = orders.get(orderId)!;
      if (o.stockHandled?.includes(productId)) return false;
      o.stockHandled = [...(o.stockHandled ?? []), productId];
      o.issues = [...(o.issues ?? []), issue];
      return true;
    }),
    markFulfilled: vi.fn(async (id) => {
      orders.get(id)!.fulfilment = 'done';
    }),
    sendEmail: vi.fn(async () => {}),
    metric: vi.fn((name) => void metrics.push(name)),
    log: vi.fn(),
  };
  return { deps, orders, products, metrics };
}

describe('handleCheckoutEvent', () => {
  it('marks the order paid, decrements stock and emails customer + owner', async () => {
    const { deps, orders, metrics } = fakeDeps();
    const outcome = await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);

    expect(outcome).toBe('paid');
    expect(orders.get('cs_test_123')).toMatchObject({ status: 'PAID', totalCents: 7000, customerEmail: 'buyer@example.com', fulfilment: 'done' });
    expect(deps.reserveStock).toHaveBeenCalledWith('cs_test_123', 'p1', 2);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.sendEmail).mock.calls.map(([m]) => m.to)).toEqual(['buyer@example.com', 'owner@shop.example']);
    expect(metrics).toContain('CheckoutCompleted');
  });

  it('is idempotent when Stripe delivers the same event twice', async () => {
    const { deps } = fakeDeps();
    await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);
    const second = await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);

    expect(second).toBe('duplicate');
    expect(deps.reserveStock).toHaveBeenCalledTimes(1);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('waits for delayed payment methods before fulfilling', async () => {
    const { deps, orders } = fakeDeps();
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session({ paymentStatus: 'unpaid' }), settings)).toBe('awaiting-payment');
    expect(orders.get('cs_test_123')!.status).toBe('PENDING');
    expect(await handleCheckoutEvent(deps, 'checkout.session.async_payment_succeeded', session(), settings)).toBe('paid');
  });

  it('flags the order when stock ran out (oversell) instead of failing', async () => {
    const { deps, orders, metrics } = fakeDeps([order()], { p1: 1 });
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('paid');
    expect(orders.get('cs_test_123')!.issues?.[0]).toMatch(/Not enough stock/);
    expect(metrics).toContain('StockConflict');
  });

  it('resumes after a failure part-way through, without taking stock twice', async () => {
    const twoItems = order({
      items: [
        { productId: 'p1', name: 'Speckled Mug', unitPriceCents: 3200, quantity: 2 },
        { productId: 'p2', name: 'Candle', unitPriceCents: 1800, quantity: 1 },
      ],
    });
    const { deps, orders, products } = fakeDeps([twoItems], { p1: 5, p2: 3 });
    const real = vi.mocked(deps.reserveStock).getMockImplementation()!;
    vi.mocked(deps.reserveStock)
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

    await expect(handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).rejects.toThrow();
    expect(orders.get('cs_test_123')).toMatchObject({ status: 'PAID', fulfilment: 'pending' });
    expect(deps.sendEmail).not.toHaveBeenCalled();

    // Stripe retries the webhook.
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('paid');
    expect(products.get('p1')).toBe(3); // taken once, not twice
    expect(products.get('p2')).toBe(2);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    expect(orders.get('cs_test_123')!.fulfilment).toBe('done');

    // A further retry after success is a plain duplicate.
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('duplicate');
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('does not resume orders paid before fulfilment tracking existed', async () => {
    const { deps } = fakeDeps([order({ status: 'PAID' })]);
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('duplicate');
    expect(deps.reserveStock).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('explains a deleted product instead of reporting a stock conflict', async () => {
    const { deps, orders, metrics } = fakeDeps([order()], {});
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('paid');
    expect(orders.get('cs_test_123')!.issues?.[0]).toMatch(/was deleted from the shop/);
    expect(metrics).not.toContain('StockConflict');
  });

  it('records an email failure metric but still succeeds', async () => {
    const { deps, metrics } = fakeDeps();
    vi.mocked(deps.sendEmail).mockRejectedValue(new Error('SES sandbox'));
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('paid');
    expect(metrics.filter((m) => m === 'OrderEmailFailed')).toHaveLength(2);
  });

  it('skips emails without counting failures when no sender is configured', async () => {
    const { deps, orders, metrics } = fakeDeps();
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), { ...settings, emailEnabled: false })).toBe('paid');
    expect(orders.get('cs_test_123')!.status).toBe('PAID');
    expect(deps.reserveStock).toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(metrics).not.toContain('OrderEmailFailed');
  });

  it('expires abandoned checkouts', async () => {
    const { deps, orders, metrics } = fakeDeps();
    expect(await handleCheckoutEvent(deps, 'checkout.session.expired', session({ paymentStatus: 'unpaid' }), settings)).toBe('expired');
    expect(orders.get('cs_test_123')!.status).toBe('EXPIRED');
    expect(metrics).toContain('CheckoutExpired');
  });

  it('never moves a paid order back to expired', async () => {
    const { deps, orders } = fakeDeps([order({ status: 'PAID' })]);
    expect(await handleCheckoutEvent(deps, 'checkout.session.expired', session(), settings)).toBe('duplicate');
    expect(orders.get('cs_test_123')!.status).toBe('PAID');
  });

  it('ignores unrelated events', async () => {
    const { deps } = fakeDeps();
    expect(await handleCheckoutEvent(deps, 'checkout.session.updated', session(), settings)).toBe('ignored');
  });
});
