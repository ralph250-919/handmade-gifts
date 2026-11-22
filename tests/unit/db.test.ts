import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order, Product } from '../../backend/src/lib/types.js';
import { order, product } from './fixtures.js';

// Stand-in for DynamoDB: answers reads from the maps below and scripts transaction outcomes.
const store = vi.hoisted(() => ({
  orders: new Map<string, Order>(),
  products: new Map<string, Product>(),
  transactResults: [] as Array<'ok' | { reasons: string[] }>,
  transactCalls: [] as unknown[],
}));

vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>();
  const send = async (cmd: { constructor: { name: string }; input: any }) => {
    switch (cmd.constructor.name) {
      case 'GetCommand':
        return { Item: store.orders.get(cmd.input.Key.id) };
      case 'BatchGetCommand': {
        const [table, req] = Object.entries(cmd.input.RequestItems as Record<string, { Keys: { id: string }[] }>)[0]!;
        return { Responses: { [table]: req.Keys.map((k) => store.products.get(k.id)).filter(Boolean) } };
      }
      case 'TransactWriteCommand': {
        store.transactCalls.push(cmd.input);
        const r = store.transactResults.shift() ?? 'ok';
        if (r === 'ok') return {};
        throw Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: r.reasons.map((Code) => ({ Code })),
        });
      }
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  };
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send }) } };
});

process.env.PRODUCTS_TABLE = 'products';
process.env.ORDERS_TABLE = 'orders';
const { markOrderPaid } = await import('../../backend/src/lib/db.js');
const issueFor = (i: { name: string }) => `short: ${i.name}`;

type Tx = { TransactItems: { Update: { TableName: string; Key: { id: string }; ExpressionAttributeValues: Record<string, unknown> } }[] };

beforeEach(() => {
  store.orders.clear();
  store.products.clear();
  store.transactResults = [];
  store.transactCalls = [];
  store.orders.set('cs_test_123', order());
  store.products.set('p1', product());
});

describe('markOrderPaid (DynamoDB transaction)', () => {
  it('marks the order paid and takes stock in a single transaction', async () => {
    const res = await markOrderPaid('cs_test_123', { totalCents: 7000 }, issueFor);
    expect(res?.order).toMatchObject({ status: 'PAID', totalCents: 7000 });
    expect(res?.stockConflicts).toEqual([]);
    expect(store.transactCalls).toHaveLength(1);
    const items = (store.transactCalls[0] as Tx).TransactItems;
    expect(items.map((i) => i.Update.TableName)).toEqual(['orders', 'products']);
    expect(items[1]!.Update.ExpressionAttributeValues[':q']).toBe(2);
  });

  it('returns undefined for an order that is already paid', async () => {
    store.orders.set('cs_test_123', order({ status: 'PAID' }));
    expect(await markOrderPaid('cs_test_123', {}, issueFor)).toBeUndefined();
    expect(store.transactCalls).toHaveLength(0);
  });

  it('returns undefined when another delivery wins the race', async () => {
    store.transactResults = [{ reasons: ['ConditionalCheckFailed', 'None'] }];
    expect(await markOrderPaid('cs_test_123', {}, issueFor)).toBeUndefined();
  });

  it('records a stock issue instead of failing when stock ran out', async () => {
    store.transactResults = [{ reasons: ['None', 'ConditionalCheckFailed'] }, 'ok'];
    const res = await markOrderPaid('cs_test_123', {}, issueFor);
    expect(res?.stockConflicts.map((i) => i.productId)).toEqual(['p1']);
    expect(res?.order.issues).toEqual(['short: Speckled Mug']);
    const retry = (store.transactCalls[1] as Tx).TransactItems;
    expect(retry).toHaveLength(1); // only the order update; the short product is no longer decremented
  });

  it('does not touch stock for made-to-order products', async () => {
    store.products.set('p1', product({ stock: null }));
    await markOrderPaid('cs_test_123', {}, issueFor);
    expect((store.transactCalls[0] as Tx).TransactItems).toHaveLength(1);
  });

  it('flags the right product when one of several runs out', async () => {
    store.orders.set('cs_test_123', order({
      items: [
        { productId: 'p1', name: 'Speckled Mug', unitPriceCents: 3200, quantity: 2 },
        { productId: 'p2', name: 'Candle', unitPriceCents: 1800, quantity: 1 },
      ],
    }));
    store.products.set('p2', product({ id: 'p2', name: 'Candle', stock: 0 }));
    store.transactResults = [{ reasons: ['None', 'None', 'ConditionalCheckFailed'] }, 'ok'];
    const res = await markOrderPaid('cs_test_123', {}, issueFor);
    expect(res?.stockConflicts.map((i) => i.productId)).toEqual(['p2']);
    expect(res?.order.issues).toEqual(['short: Candle']);
    const retry = (store.transactCalls[1] as Tx).TransactItems;
    expect(retry.map((i) => i.Update.Key.id)).toEqual(['cs_test_123', 'p1']);
  });

  it('adds up repeated lines for the same product into one stock update', async () => {
    store.orders.set('cs_test_123', order({
      items: [
        { productId: 'p1', name: 'Speckled Mug', unitPriceCents: 3200, quantity: 2 },
        { productId: 'p1', name: 'Speckled Mug', unitPriceCents: 3200, quantity: 1 },
      ],
    }));
    await markOrderPaid('cs_test_123', {}, issueFor);
    const items = (store.transactCalls[0] as Tx).TransactItems;
    expect(items).toHaveLength(2);
    expect(items[1]!.Update.ExpressionAttributeValues[':q']).toBe(3);
  });

  it('records an issue for a product that was deleted', async () => {
    store.products.clear();
    const res = await markOrderPaid('cs_test_123', {}, issueFor);
    expect(res?.order.issues).toEqual(['short: Speckled Mug']);
    expect((store.transactCalls[0] as Tx).TransactItems).toHaveLength(1);
  });

  it('retries when another checkout touches the same product at the same moment', async () => {
    store.transactResults = [{ reasons: ['None', 'TransactionConflict'] }, 'ok'];
    const res = await markOrderPaid('cs_test_123', {}, issueFor);
    expect(res?.stockConflicts).toEqual([]);
    expect(store.transactCalls).toHaveLength(2);
  });

  it('gives up with an error (so Stripe retries later) after repeated conflicts', async () => {
    store.transactResults = Array.from({ length: 10 }, () => ({ reasons: ['None', 'TransactionConflict'] }));
    await expect(markOrderPaid('cs_test_123', {}, issueFor)).rejects.toThrow('after several attempts');
  });

  it('does not overwrite stored fields with missing values in the returned order', async () => {
    store.orders.set('cs_test_123', order({ shippingCents: 600 }));
    const res = await markOrderPaid('cs_test_123', { shippingCents: undefined, totalCents: 7000 }, issueFor);
    expect(res?.order).toMatchObject({ shippingCents: 600, totalCents: 7000 });
  });

  it('lets other errors propagate so Stripe retries the webhook', async () => {
    store.transactResults = [{ reasons: ['None', 'ThrottlingError'] }];
    await expect(markOrderPaid('cs_test_123', {}, issueFor)).rejects.toThrow('Transaction cancelled');
  });
});
