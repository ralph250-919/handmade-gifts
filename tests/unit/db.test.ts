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
      case 'GetCommand': {
        const table = cmd.input.TableName === 'orders' ? store.orders : store.products;
        return { Item: structuredClone(table.get(cmd.input.Key.id)) };
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
const { createPendingOrder, transitionOrderWithStock } = await import('../../backend/src/lib/db.js');

type Item = {
  Put?: { TableName: string; ConditionExpression: string };
  Update?: { TableName: string; Key: { id: string }; UpdateExpression: string; ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> };
};
const items = (call: number) => (store.transactCalls[call] as { TransactItems: Item[] }).TransactItems;

beforeEach(() => {
  store.orders.clear();
  store.products.clear();
  store.transactResults = [];
  store.transactCalls = [];
  store.orders.set('cs_test_123', order({ reservedStock: [{ productId: 'p1', quantity: 2 }] }));
  store.products.set('p1', product());
});

describe('createPendingOrder (stock reservation)', () => {
  const pending = (o: Partial<Order> = {}) => order({ reservedStock: [{ productId: 'p1', quantity: 2 }], ...o });

  it('saves the order and takes the reserved stock in one transaction', async () => {
    expect(await createPendingOrder(pending())).toBeUndefined();
    const [put, take] = items(0);
    expect(put!.Put).toMatchObject({ TableName: 'orders', ConditionExpression: 'attribute_not_exists(id)' });
    expect(take!.Update).toMatchObject({ TableName: 'products', Key: { id: 'p1' }, ConditionExpression: 'attribute_exists(id) AND stock >= :q' });
    expect(take!.Update!.UpdateExpression).toContain('stock - :q');
    expect(take!.Update!.ExpressionAttributeValues[':q']).toBe(2);
  });

  it('returns the product that ran out, writing nothing', async () => {
    store.transactResults = [{ reasons: ['None', 'ConditionalCheckFailed'] }];
    expect(await createPendingOrder(pending())).toBe('p1');
  });

  it('retries briefly when another checkout touches the same product at the same moment', async () => {
    store.transactResults = [{ reasons: ['None', 'TransactionConflict'] }, 'ok'];
    expect(await createPendingOrder(pending())).toBeUndefined();
    expect(store.transactCalls).toHaveLength(2);
  });

  it('gives up after a few conflicts instead of retrying forever', async () => {
    store.transactResults = Array(10).fill({ reasons: ['None', 'TransactionConflict'] });
    await expect(createPendingOrder(pending())).rejects.toThrow('Transaction cancelled');
    expect(store.transactCalls).toHaveLength(5);
  });
});

describe('transitionOrderWithStock', () => {
  it('changes the order and the stock in one transaction and returns the stored order', async () => {
    const res = await transitionOrderWithStock('cs_test_123', ['PENDING'], 'EXPIRED', {}, [{ productId: 'p1', delta: 2 }]);
    expect(res?.shortfalls).toEqual([]);
    const [orderUpdate, release] = items(0);
    expect(orderUpdate!.Update!.TableName).toBe('orders');
    expect(orderUpdate!.Update!.ConditionExpression).toContain('#status IN (:from0)');
    expect(release!.Update!.UpdateExpression).toContain('stock + :q');
    expect(release!.Update!.ConditionExpression).toContain('attribute_type(stock, :num)');
  });

  it('returns undefined when the order is not in the expected state (duplicate delivery)', async () => {
    store.transactResults = [{ reasons: ['ConditionalCheckFailed', 'None'] }];
    expect(await transitionOrderWithStock('cs_test_123', ['PENDING'], 'PAID', {}, [{ productId: 'p1', delta: -2 }])).toBeUndefined();
  });

  it('records a shortfall as an order issue when there is not enough stock', async () => {
    store.products.set('p1', product({ stock: 1 }));
    store.transactResults = [{ reasons: ['None', 'ConditionalCheckFailed'] }, 'ok'];
    const res = await transitionOrderWithStock('cs_test_123', ['PENDING'], 'PAID', {}, [{ productId: 'p1', delta: -2, shortfallIssue: 'short: mug' }]);
    expect(res?.shortfalls).toEqual(['p1']);
    const retry = items(1);
    expect(retry).toHaveLength(1); // the stock change is dropped...
    expect(retry[0]!.Update!.ExpressionAttributeValues[':issues']).toEqual(['short: mug']); // ...and noted on the order
  });

  it('silently skips products that were deleted or are made to order', async () => {
    store.products.set('p1', product({ stock: null }));
    store.transactResults = [{ reasons: ['None', 'ConditionalCheckFailed'] }, 'ok'];
    const res = await transitionOrderWithStock('cs_test_123', ['PENDING'], 'PAID', {}, [{ productId: 'p1', delta: -2, shortfallIssue: 'short' }]);
    expect(res?.shortfalls).toEqual([]);
    expect(items(1)[0]!.Update!.ExpressionAttributeValues[':issues']).toBeUndefined();
  });

  it('retries on a write conflict, then gives up so Stripe can retry later', async () => {
    store.transactResults = [{ reasons: ['TransactionConflict', 'None'] }, 'ok'];
    expect(await transitionOrderWithStock('cs_test_123', ['PENDING'], 'PAID', {}, [])).toBeDefined();

    store.transactCalls = [];
    store.transactResults = Array(10).fill({ reasons: ['TransactionConflict'] });
    await expect(transitionOrderWithStock('cs_test_123', ['PENDING'], 'PAID', {}, [])).rejects.toThrow('Transaction cancelled');
    expect(store.transactCalls).toHaveLength(5);
  });
});
