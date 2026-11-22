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

/** An order created by the current checkout: 2 × p1 already reserved (stock 5 → 3). */
const reservedOrder = (o: Partial<Order> = {}) => order({ reservedStock: [{ productId: 'p1', quantity: 2 }], ...o });

/**
 * In-memory fake of the order and product stores with the same all-or-nothing
 * semantics as the DynamoDB transaction in db.transitionOrderWithStock.
 */
function fakeDeps(initial: Order[] = [reservedOrder()], initialStock: Record<string, number | null> = { p1: 3 }) {
  const orders = new Map(initial.map((o) => [o.id, structuredClone(o)]));
  const stock = new Map(Object.entries(initialStock));
  const metrics: string[] = [];
  const deps: FulfillmentDeps = {
    getOrder: vi.fn(async (id) => structuredClone(orders.get(id))),
    transitionOrderWithStock: vi.fn(async (id, from, to, fields, changes) => {
      const o = orders.get(id);
      if (!o || !from.includes(o.status)) return undefined;
      const shortfalls: string[] = [];
      for (const c of changes) {
        const s = stock.get(c.productId);
        if (s === undefined || s === null) continue;
        if (s + c.delta < 0) {
          shortfalls.push(c.productId);
          if (c.shortfallIssue) o.issues = [...(o.issues ?? []), c.shortfallIssue];
          continue;
        }
        stock.set(c.productId, s + c.delta);
      }
      Object.assign(o, fields, { status: to });
      return { order: structuredClone(o), shortfalls };
    }),
    markOrderNotified: vi.fn(async (id) => {
      orders.get(id)!.notifiedAt = '2026-01-01T00:05:00.000Z';
    }),
    sendEmail: vi.fn(async () => {}),
    metric: vi.fn((name) => void metrics.push(name)),
    log: vi.fn(),
  };
  return { deps, orders, stock, metrics };
}

const paid = (deps: FulfillmentDeps, type = 'checkout.session.completed', s = session(), st: typeof settings & { emailEnabled?: boolean } = settings) =>
  handleCheckoutEvent(deps, type, s, st);

describe('handleCheckoutEvent: payment', () => {
  it('marks the order paid and emails customer + owner, without taking the already-reserved stock again', async () => {
    const { deps, orders, stock, metrics } = fakeDeps();
    expect(await paid(deps)).toBe('paid');

    expect(orders.get('cs_test_123')).toMatchObject({ status: 'PAID', totalCents: 7000, customerEmail: 'buyer@example.com' });
    expect(orders.get('cs_test_123')!.notifiedAt).toBeDefined();
    expect(stock.get('p1')).toBe(3);
    expect(vi.mocked(deps.sendEmail).mock.calls.map(([m]) => m.to)).toEqual(['buyer@example.com', 'owner@shop.example']);
    expect(metrics).toContain('CheckoutCompleted');
  });

  it('is idempotent when Stripe delivers the same event twice', async () => {
    const { deps, metrics } = fakeDeps();
    await paid(deps);
    expect(await paid(deps)).toBe('duplicate');
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    expect(metrics.filter((m) => m === 'CheckoutCompleted')).toHaveLength(1);
  });

  it('finishes the job on retry when the webhook failed right after the order was marked paid', async () => {
    const { deps, orders, stock } = fakeDeps();
    // The write commits, then the function dies (timeout, crash) before sending the emails.
    const commit = vi.mocked(deps.transitionOrderWithStock).getMockImplementation()!;
    vi.mocked(deps.transitionOrderWithStock).mockImplementationOnce(async (...args) => {
      await commit(...args);
      throw new Error('Task timed out');
    });

    await expect(paid(deps)).rejects.toThrow('Task timed out'); // → 500, Stripe retries
    expect(orders.get('cs_test_123')!.status).toBe('PAID');
    expect(deps.sendEmail).not.toHaveBeenCalled();

    expect(await paid(deps)).toBe('resumed');
    expect(vi.mocked(deps.sendEmail).mock.calls.map(([m]) => m.to)).toEqual(['buyer@example.com', 'owner@shop.example']);
    expect(orders.get('cs_test_123')!.notifiedAt).toBeDefined();
    expect(stock.get('p1')).toBe(3);

    expect(await paid(deps)).toBe('duplicate');
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('waits for delayed payment methods before fulfilling', async () => {
    const { deps, orders } = fakeDeps();
    expect(await paid(deps, 'checkout.session.completed', session({ paymentStatus: 'unpaid' }))).toBe('awaiting-payment');
    expect(orders.get('cs_test_123')!.status).toBe('PENDING');
    expect(await paid(deps, 'checkout.session.async_payment_succeeded')).toBe('paid');
  });

  it('ignores checkouts that are not from this shop', async () => {
    const { deps } = fakeDeps([]);
    expect(await paid(deps)).toBe('duplicate');
    expect(deps.transitionOrderWithStock).not.toHaveBeenCalled();
  });

  it('records an email failure metric but still succeeds', async () => {
    const { deps, metrics } = fakeDeps();
    vi.mocked(deps.sendEmail).mockRejectedValue(new Error('SES sandbox'));
    expect(await paid(deps)).toBe('paid');
    expect(metrics.filter((m) => m === 'OrderEmailFailed')).toHaveLength(2);
  });

  it('skips emails without counting failures when no sender is configured', async () => {
    const { deps, orders, metrics } = fakeDeps();
    expect(await paid(deps, undefined, undefined, { ...settings, emailEnabled: false })).toBe('paid');
    expect(orders.get('cs_test_123')!.status).toBe('PAID');
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(metrics).not.toContain('OrderEmailFailed');
  });
});

describe('handleCheckoutEvent: orders created before stock reservation', () => {
  it('takes the stock in the same write that marks the order paid', async () => {
    const { deps, stock } = fakeDeps([order()], { p1: 5 });
    expect(await paid(deps)).toBe('paid');
    expect(stock.get('p1')).toBe(3);
    expect(deps.transitionOrderWithStock).toHaveBeenCalledWith('cs_test_123', ['PENDING'], 'PAID', expect.anything(), [
      expect.objectContaining({ productId: 'p1', delta: -2 }),
    ]);
  });

  it('flags the order when stock ran out (oversell) instead of failing', async () => {
    const { deps, orders, stock, metrics } = fakeDeps([order()], { p1: 1 });
    expect(await paid(deps)).toBe('paid');
    expect(orders.get('cs_test_123')!.issues?.[0]).toMatch(/Not enough stock/);
    expect(stock.get('p1')).toBe(1);
    expect(metrics).toContain('StockConflict');
  });
});

describe('handleCheckoutEvent: abandoned and failed checkouts', () => {
  it('expires abandoned checkouts and puts their reserved stock back, once', async () => {
    const { deps, orders, stock, metrics } = fakeDeps();
    expect(await paid(deps, 'checkout.session.expired', session({ paymentStatus: 'unpaid' }))).toBe('expired');
    expect(orders.get('cs_test_123')!.status).toBe('EXPIRED');
    expect(stock.get('p1')).toBe(5);
    expect(metrics).toContain('CheckoutExpired');

    expect(await paid(deps, 'checkout.session.expired', session({ paymentStatus: 'unpaid' }))).toBe('duplicate');
    expect(stock.get('p1')).toBe(5);
  });

  it('puts reserved stock back when a delayed payment fails', async () => {
    const { deps, orders, stock } = fakeDeps();
    expect(await paid(deps, 'checkout.session.async_payment_failed', session({ paymentStatus: 'unpaid' }))).toBe('payment-failed');
    expect(orders.get('cs_test_123')!.status).toBe('CANCELLED');
    expect(stock.get('p1')).toBe(5);
  });

  it('releases nothing for older orders that never reserved stock', async () => {
    const { deps, stock } = fakeDeps([order()], { p1: 5 });
    expect(await paid(deps, 'checkout.session.expired')).toBe('expired');
    expect(stock.get('p1')).toBe(5);
  });

  it('never moves a paid order back to expired or releases its stock', async () => {
    const { deps, orders, stock } = fakeDeps([reservedOrder({ status: 'PAID' })]);
    expect(await paid(deps, 'checkout.session.expired')).toBe('duplicate');
    expect(orders.get('cs_test_123')!.status).toBe('PAID');
    expect(stock.get('p1')).toBe(3);
  });

  it('ignores unrelated events', async () => {
    const { deps } = fakeDeps();
    expect(await paid(deps, 'checkout.session.updated')).toBe('ignored');
  });
});
