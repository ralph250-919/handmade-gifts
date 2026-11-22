import { describe, expect, it, vi } from 'vitest';
import { handleCheckoutEvent, type CheckoutSessionInfo, type FulfillmentDeps } from '../../backend/src/lib/fulfillment.js';
import type { Order, OrderItem } from '../../backend/src/lib/types.js';
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

/** In-memory fake of the order and stock store with the same all-or-nothing semantics as DynamoDB. */
function fakeDeps(initial: Order[] = [order()], stock: Record<string, number | null> = { p1: 5 }) {
  const orders = new Map(initial.map((o) => [o.id, { ...o }]));
  const stockLeft = new Map(Object.entries(stock));
  const metrics: string[] = [];
  const deps: FulfillmentDeps = {
    transitionOrder: vi.fn(async (id, from, to, fields) => {
      const o = orders.get(id);
      if (!o || !from.includes(o.status)) return undefined;
      Object.assign(o, fields, { status: to });
      return { ...o };
    }),
    markOrderPaid: vi.fn(async (id: string, fields: Partial<Order>, issueFor: (item: OrderItem) => string) => {
      const o = orders.get(id);
      if (!o || o.status !== 'PENDING') return undefined;
      const need = new Map<string, number>();
      for (const i of o.items) need.set(i.productId, (need.get(i.productId) ?? 0) + i.quantity);
      const short = (pid: string) => {
        const left = stockLeft.get(pid);
        return left === undefined || (left !== null && left < need.get(pid)!);
      };
      const stockConflicts = o.items.filter((i) => short(i.productId));
      for (const [pid, q] of need) {
        const left = stockLeft.get(pid);
        if (typeof left === 'number' && !short(pid)) stockLeft.set(pid, left - q);
      }
      Object.assign(o, fields, { status: 'PAID' });
      if (stockConflicts.length) o.issues = [...(o.issues ?? []), ...stockConflicts.map(issueFor)];
      return { order: { ...o }, stockConflicts };
    }),
    sendEmail: vi.fn(async () => {}),
    metric: vi.fn((name) => void metrics.push(name)),
    log: vi.fn(),
  };
  return { deps, orders, metrics, stockLeft };
}

describe('handleCheckoutEvent', () => {
  it('marks the order paid, decrements stock and emails customer + owner', async () => {
    const { deps, orders, metrics, stockLeft } = fakeDeps();
    const outcome = await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);

    expect(outcome).toBe('paid');
    expect(orders.get('cs_test_123')).toMatchObject({ status: 'PAID', totalCents: 7000, customerEmail: 'buyer@example.com' });
    expect(stockLeft.get('p1')).toBe(3);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.sendEmail).mock.calls.map(([m]) => m.to)).toEqual(['buyer@example.com', 'owner@shop.example']);
    expect(metrics).toContain('CheckoutCompleted');
  });

  it('is idempotent when Stripe delivers the same event twice', async () => {
    const { deps, stockLeft } = fakeDeps();
    await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);
    const second = await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);

    expect(second).toBe('duplicate');
    expect(stockLeft.get('p1')).toBe(3);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('waits for delayed payment methods before fulfilling', async () => {
    const { deps, orders } = fakeDeps();
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session({ paymentStatus: 'unpaid' }), settings)).toBe('awaiting-payment');
    expect(orders.get('cs_test_123')!.status).toBe('PENDING');
    expect(await handleCheckoutEvent(deps, 'checkout.session.async_payment_succeeded', session(), settings)).toBe('paid');
  });

  it('flags the order when stock ran out (oversell) instead of failing', async () => {
    const { deps, orders, metrics, stockLeft } = fakeDeps([order()], { p1: 1 });
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('paid');
    expect(orders.get('cs_test_123')!.issues?.[0]).toMatch(/Not enough stock/);
    expect(metrics).toContain('StockConflict');
    expect(stockLeft.get('p1')).toBe(1);
  });

  it('fulfils the order on Stripe\'s retry when the first attempt failed part-way', async () => {
    const { deps, orders, stockLeft } = fakeDeps();
    vi.mocked(deps.markOrderPaid).mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    await expect(handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).rejects.toThrow();
    expect(orders.get('cs_test_123')!.status).toBe('PENDING');

    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('paid');
    expect(stockLeft.get('p1')).toBe(3);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('never writes customer email addresses to the logs when an email fails', async () => {
    const { deps } = fakeDeps();
    vi.mocked(deps.sendEmail).mockRejectedValue(new Error('Email address is not verified: buyer@example.com'));
    await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toMatch(/buyer@example\.com|owner@shop\.example/);
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
    expect(deps.markOrderPaid).toHaveBeenCalled();
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
