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

/** In-memory fake of the order store with the same conditional semantics as DynamoDB. */
function fakeDeps(initial: Order[] = [order()]) {
  const orders = new Map(initial.map((o) => [o.id, { ...o }]));
  const metrics: string[] = [];
  const deps: FulfillmentDeps = {
    transitionOrder: vi.fn(async (id, from, to, fields) => {
      const o = orders.get(id);
      if (!o || !from.includes(o.status)) return undefined;
      Object.assign(o, fields, { status: to });
      return { ...o };
    }),
    decrementStock: vi.fn(async () => true),
    addOrderIssue: vi.fn(async (id, issue) => {
      const o = orders.get(id)!;
      o.issues = [...(o.issues ?? []), issue];
    }),
    sendEmail: vi.fn(async () => {}),
    metric: vi.fn((name) => void metrics.push(name)),
    log: vi.fn(),
  };
  return { deps, orders, metrics };
}

describe('handleCheckoutEvent', () => {
  it('marks the order paid, decrements stock and emails customer + owner', async () => {
    const { deps, orders, metrics } = fakeDeps();
    const outcome = await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);

    expect(outcome).toBe('paid');
    expect(orders.get('cs_test_123')).toMatchObject({ status: 'PAID', totalCents: 7000, customerEmail: 'buyer@example.com' });
    expect(deps.decrementStock).toHaveBeenCalledWith('p1', 2);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.sendEmail).mock.calls.map(([m]) => m.to)).toEqual(['buyer@example.com', 'owner@shop.example']);
    expect(metrics).toContain('CheckoutCompleted');
  });

  it('is idempotent when Stripe delivers the same event twice', async () => {
    const { deps } = fakeDeps();
    await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);
    const second = await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings);

    expect(second).toBe('duplicate');
    expect(deps.decrementStock).toHaveBeenCalledTimes(1);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('waits for delayed payment methods before fulfilling', async () => {
    const { deps, orders } = fakeDeps();
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session({ paymentStatus: 'unpaid' }), settings)).toBe('awaiting-payment');
    expect(orders.get('cs_test_123')!.status).toBe('PENDING');
    expect(await handleCheckoutEvent(deps, 'checkout.session.async_payment_succeeded', session(), settings)).toBe('paid');
  });

  it('flags the order when stock ran out (oversell) instead of failing', async () => {
    const { deps, orders, metrics } = fakeDeps();
    vi.mocked(deps.decrementStock).mockResolvedValue(false);
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('paid');
    expect(orders.get('cs_test_123')!.issues?.[0]).toMatch(/Not enough stock/);
    expect(metrics).toContain('StockConflict');
  });

  it('records an email failure metric but still succeeds', async () => {
    const { deps, metrics } = fakeDeps();
    vi.mocked(deps.sendEmail).mockRejectedValue(new Error('SES sandbox'));
    expect(await handleCheckoutEvent(deps, 'checkout.session.completed', session(), settings)).toBe('paid');
    expect(metrics.filter((m) => m === 'OrderEmailFailed')).toHaveLength(2);
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
