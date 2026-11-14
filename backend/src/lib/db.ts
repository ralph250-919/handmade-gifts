import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { env } from './config.js';
import type { StockResult } from './fulfillment.js';
import { tracer } from './observability.js';
import type { Order, OrderStatus, Product } from './types.js';

const doc = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), {
  marshallOptions: { removeUndefinedValues: true },
});

const productsTable = () => env('PRODUCTS_TABLE');
const ordersTable = () => env('ORDERS_TABLE');

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** For a cancelled transaction, which of its items (by index) failed their condition. */
function failedTransactionItems(err: unknown): number[] | undefined {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (e?.name !== 'TransactionCanceledException') return undefined;
  return (e.CancellationReasons ?? []).flatMap((r, i) => (r.Code === 'ConditionalCheckFailed' ? [i] : []));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Products ----------

export async function listProducts(opts: { includeInactive?: boolean } = {}): Promise<Product[]> {
  const items: Product[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(new ScanCommand({ TableName: productsTable(), ExclusiveStartKey }));
    items.push(...((res.Items ?? []) as Product[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items
    .filter((p) => opts.includeInactive || p.active)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getProduct(id: string): Promise<Product | undefined> {
  const res = await doc.send(new GetCommand({ TableName: productsTable(), Key: { id } }));
  return res.Item as Product | undefined;
}

export async function getProductBySlug(slug: string): Promise<Product | undefined> {
  const res = await doc.send(
    new QueryCommand({
      TableName: productsTable(),
      IndexName: 'bySlug',
      KeyConditionExpression: 'slug = :s',
      ExpressionAttributeValues: { ':s': slug },
    }),
  );
  // Slugs should be unique, but the check that keeps them so reads an eventually
  // consistent index. If two products ever share one, always pick the oldest.
  const matches = (res.Items ?? []) as Product[];
  return matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

export async function getProductsByIds(ids: string[]): Promise<Map<string, Product>> {
  const map = new Map<string, Product>();
  if (ids.length === 0) return map;
  // BatchGet accepts up to 100 keys; carts are capped well below that.
  let request: Record<string, { Keys: Record<string, unknown>[] }> | undefined = {
    [productsTable()]: { Keys: [...new Set(ids)].map((id) => ({ id })) },
  };
  for (let attempt = 0; request && Object.keys(request).length > 0; attempt++) {
    // Unprocessed keys mean DynamoDB is throttling us: back off before asking again.
    if (attempt > 0) await sleep(Math.min(50 * 2 ** attempt, 1000));
    const res = await doc.send(new BatchGetCommand({ RequestItems: request }));
    for (const p of (res.Responses?.[productsTable()] ?? []) as Product[]) map.set(p.id, p);
    request = res.UnprocessedKeys as typeof request;
  }
  return map;
}

export async function putProduct(product: Product): Promise<void> {
  await doc.send(new PutCommand({ TableName: productsTable(), Item: product }));
}

export async function deleteProduct(id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: productsTable(), Key: { id } }));
}

// ---------- Orders ----------

export async function createPendingOrder(order: Order): Promise<void> {
  await doc.send(
    new PutCommand({ TableName: ordersTable(), Item: order, ConditionExpression: 'attribute_not_exists(id)' }),
  );
}

export async function getOrder(id: string): Promise<Order | undefined> {
  const res = await doc.send(new GetCommand({ TableName: ordersTable(), Key: { id } }));
  return res.Item as Order | undefined;
}

/**
 * Moves an order between states only if it is currently in one of `from`.
 * Returns the updated order, or undefined if the transition did not apply
 * (e.g. a duplicate Stripe webhook delivery) — this makes webhooks idempotent.
 */
export async function transitionOrder(
  id: string,
  from: readonly OrderStatus[],
  to: OrderStatus,
  fields: Partial<Order> = {},
): Promise<Order | undefined> {
  const set: Record<string, unknown> = { ...fields, status: to, updatedAt: new Date().toISOString() };
  delete set.id;
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts = Object.entries(set)
    .filter(([, v]) => v !== undefined)
    .map(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      return `#f${i} = :v${i}`;
    });
  from.forEach((s, i) => (values[`:from${i}`] = s));
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: ordersTable(),
        Key: { id },
        UpdateExpression: `SET ${parts.join(', ')}`,
        ConditionExpression: `attribute_exists(id) AND #status IN (${from.map((_, i) => `:from${i}`).join(', ')})`,
        ExpressionAttributeNames: { ...names, '#status': 'status' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return res.Attributes as Order;
  } catch (err) {
    if (isConditionFailure(err)) return undefined;
    throw err;
  }
}

// ---------- Fulfilment (see lib/fulfillment.ts) ----------

/** Appends `productId` to the order's stockHandled list, but only if it isn't there yet. */
function markStockHandled(orderId: string, productId: string, extra: { set?: string; values?: Record<string, unknown> } = {}) {
  return {
    TableName: ordersTable(),
    Key: { id: orderId },
    UpdateExpression: `SET stockHandled = list_append(if_not_exists(stockHandled, :empty), :pidList)${extra.set ? `, ${extra.set}` : ''}`,
    ConditionExpression: 'attribute_exists(id) AND NOT contains(stockHandled, :pid)',
    ExpressionAttributeValues: { ':empty': [], ':pidList': [productId], ':pid': productId, ...extra.values },
  };
}

/**
 * Takes `quantity` of a product out of stock for an order, at most once per
 * order + product: the stock change and the order's stockHandled marker are
 * written in one transaction, so a webhook retry can't take the same line twice.
 */
export async function reserveStock(orderId: string, productId: string, quantity: number): Promise<StockResult> {
  const product = await getProduct(productId);
  if (!product) return 'missing';

  if (product.stock === null) {
    // Made to order: nothing to take out of stock, just record that the line is handled.
    try {
      await doc.send(new UpdateCommand(markStockHandled(orderId, productId)));
      return 'reserved';
    } catch (err) {
      if (isConditionFailure(err)) return 'already-handled';
      throw err;
    }
  }

  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: markStockHandled(orderId, productId) },
          {
            Update: {
              TableName: productsTable(),
              Key: { id: productId },
              UpdateExpression: 'SET stock = stock - :q, updatedAt = :now',
              ConditionExpression: 'stock >= :q',
              ExpressionAttributeValues: { ':q': quantity, ':now': new Date().toISOString() },
            },
          },
        ],
      }),
    );
    return 'reserved';
  } catch (err) {
    const failed = failedTransactionItems(err);
    if (!failed) throw err;
    if (failed.includes(0)) return 'already-handled';
    if (failed.includes(1)) return 'insufficient';
    throw err; // cancelled for another reason (e.g. a conflicting transaction): let Stripe retry
  }
}

/** Records a stock problem for one order line, at most once per order + product. Returns false if it was already handled. */
export async function flagStockIssue(orderId: string, productId: string, issue: string): Promise<boolean> {
  try {
    await doc.send(
      new UpdateCommand(
        markStockHandled(orderId, productId, {
          set: 'issues = list_append(if_not_exists(issues, :empty), :issue)',
          values: { ':issue': [issue] },
        }),
      ),
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

export async function markFulfilled(id: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: ordersTable(),
      Key: { id },
      UpdateExpression: 'SET fulfilment = :done, updatedAt = :now',
      ExpressionAttributeValues: { ':done': 'done', ':now': new Date().toISOString() },
    }),
  );
}

/** Safety cap on how many orders the admin page loads for one status. */
export const MAX_LISTED_ORDERS = 1000;

/**
 * Orders with the given status, newest first. Pages through the index so no
 * order is silently left out; `truncated` is true only past MAX_LISTED_ORDERS.
 */
export async function listOrders(status: OrderStatus): Promise<{ orders: Order[]; truncated: boolean }> {
  const orders: Order[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: ordersTable(),
        IndexName: 'byStatus',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
        ScanIndexForward: false,
        Limit: MAX_LISTED_ORDERS - orders.length,
        ExclusiveStartKey,
      }),
    );
    orders.push(...((res.Items ?? []) as Order[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && orders.length < MAX_LISTED_ORDERS);
  return { orders, truncated: ExclusiveStartKey !== undefined };
}

export async function ping(): Promise<void> {
  await doc.send(new ScanCommand({ TableName: productsTable(), Limit: 1 }));
}
