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
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { env } from './config.js';
import { tracer } from './observability.js';
import type { Order, OrderStatus, Product, StockChange } from './types.js';

const doc = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), {
  marshallOptions: { removeUndefinedValues: true },
});

const productsTable = () => env('PRODUCTS_TABLE');
const ordersTable = () => env('ORDERS_TABLE');

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** For a cancelled transaction: one reason per item, in order ('ConditionalCheckFailed', 'None', ...). */
function cancellationCodes(err: unknown): (string | undefined)[] | undefined {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  return e?.name === 'TransactionCanceledException' ? (e.CancellationReasons ?? []).map((r) => r.Code) : undefined;
}

/** Waits a little before retrying a transaction that collided with another write to the same item. */
const conflictBackoff = (attempt: number) => new Promise((r) => setTimeout(r, (attempt + 1) * 25 + Math.random() * 50));
const CONFLICT_RETRIES = 4;

/** A transaction item that changes a product's stock, only if the product exists and tracks stock (and has enough). */
function stockUpdate(change: StockChange, now: string) {
  const take = change.delta < 0;
  return {
    Update: {
      TableName: productsTable(),
      Key: { id: change.productId },
      UpdateExpression: `SET stock = stock ${take ? '-' : '+'} :q, updatedAt = :now`,
      ConditionExpression: take ? 'attribute_exists(id) AND stock >= :q' : 'attribute_exists(id) AND attribute_type(stock, :num)',
      ExpressionAttributeValues: { ':q': Math.abs(change.delta), ':now': now, ...(take ? {} : { ':num': 'N' }) },
    },
  };
}

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
      Limit: 1,
    }),
  );
  return res.Items?.[0] as Product | undefined;
}

export async function getProductsByIds(ids: string[]): Promise<Map<string, Product>> {
  const map = new Map<string, Product>();
  if (ids.length === 0) return map;
  // BatchGet accepts up to 100 keys; carts are capped well below that.
  let request: Record<string, { Keys: Record<string, unknown>[] }> | undefined = {
    [productsTable()]: { Keys: [...new Set(ids)].map((id) => ({ id })) },
  };
  while (request && Object.keys(request).length > 0) {
    const res = await doc.send(new BatchGetCommand({ RequestItems: request }));
    for (const p of (res.Responses?.[productsTable()] ?? []) as Product[]) map.set(p.id, p);
    request = res.UnprocessedKeys as typeof request;
  }
  return map;
}

export async function putProduct(product: Product): Promise<void> {
  await doc.send(new PutCommand({ TableName: productsTable(), Item: product }));
}

/**
 * Saves a product only if nobody changed it since it was read (optimistic locking on updatedAt).
 * Checkouts change stock and updatedAt, so this stops an admin edit from overwriting a sale.
 */
export async function putProductIfUnchanged(product: Product, expectedUpdatedAt: string): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: productsTable(),
        Item: product,
        ConditionExpression: 'updatedAt = :u',
        ExpressionAttributeValues: { ':u': expectedUpdatedAt },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

export async function deleteProduct(id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: productsTable(), Key: { id } }));
}

// ---------- Orders ----------

/**
 * Records a PENDING order and takes its `reservedStock` off the products, all in one transaction.
 * Returns the id of a product that no longer has enough stock (nothing is written), or undefined on success.
 */
export async function createPendingOrder(order: Order): Promise<string | undefined> {
  const reserve = order.reservedStock ?? [];
  for (let attempt = 0; ; attempt++) {
    const now = new Date().toISOString();
    try {
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: ordersTable(), Item: order, ConditionExpression: 'attribute_not_exists(id)' } },
            ...reserve.map((r) => stockUpdate({ productId: r.productId, delta: -r.quantity }, now)),
          ],
        }),
      );
      return undefined;
    } catch (err) {
      const codes = cancellationCodes(err);
      const failed = codes?.findIndex((c, i) => i > 0 && c === 'ConditionalCheckFailed') ?? -1;
      if (failed > 0) return reserve[failed - 1]!.productId;
      // Another checkout touched the same product at the same moment: try again shortly.
      if (codes?.includes('TransactionConflict') && attempt < CONFLICT_RETRIES) {
        await conflictBackoff(attempt);
        continue;
      }
      throw err;
    }
  }
}

export async function getOrder(id: string): Promise<Order | undefined> {
  const res = await doc.send(new GetCommand({ TableName: ordersTable(), Key: { id } }));
  return res.Item as Order | undefined;
}

function orderTransition(id: string, from: OrderStatus[], to: OrderStatus, fields: Partial<Order>, appendIssues: string[] = []) {
  const set: Record<string, unknown> = { ...fields, status: to, updatedAt: new Date().toISOString() };
  delete set.id;
  delete set.issues;
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = {};
  const parts = Object.entries(set)
    .filter(([, v]) => v !== undefined)
    .map(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      return `#f${i} = :v${i}`;
    });
  if (appendIssues.length) {
    names['#issues'] = 'issues';
    values[':issues'] = appendIssues;
    values[':empty'] = [];
    parts.push('#issues = list_append(if_not_exists(#issues, :empty), :issues)');
  }
  from.forEach((s, i) => (values[`:from${i}`] = s));
  return {
    TableName: ordersTable(),
    Key: { id },
    UpdateExpression: `SET ${parts.join(', ')}`,
    ConditionExpression: `attribute_exists(id) AND #status IN (${from.map((_, i) => `:from${i}`).join(', ')})`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  } satisfies UpdateCommandInput;
}

/**
 * Moves an order between states only if it is currently in one of `from`.
 * Returns the updated order, or undefined if the transition did not apply
 * (e.g. a duplicate Stripe webhook delivery) — this makes webhooks idempotent.
 */
export async function transitionOrder(
  id: string,
  from: OrderStatus[],
  to: OrderStatus,
  fields: Partial<Order> = {},
): Promise<Order | undefined> {
  try {
    const res = await doc.send(new UpdateCommand({ ...orderTransition(id, from, to, fields), ReturnValues: 'ALL_NEW' }));
    return res.Attributes as Order;
  } catch (err) {
    if (isConditionFailure(err)) return undefined;
    throw err;
  }
}

/**
 * Like transitionOrder, but also applies stock changes in the same DynamoDB transaction,
 * so the order's state and the products' stock can never get out of step.
 *
 * Stock changes for products that were deleted or no longer track stock are skipped.
 * A product without enough stock for a negative change is skipped too: its id is
 * returned in `shortfalls` and its `shortfallIssue` is recorded on the order.
 * Returns undefined if the order is not in one of `from`.
 */
export async function transitionOrderWithStock(
  id: string,
  from: OrderStatus[],
  to: OrderStatus,
  fields: Partial<Order> = {},
  stock: StockChange[] = [],
): Promise<{ order: Order; shortfalls: string[] } | undefined> {
  let changes = stock.filter((c) => c.delta !== 0);
  const issues: string[] = [];
  const shortfalls: string[] = [];
  // Each stock retry drops at least one change; conflict retries are capped.
  for (let conflicts = 0; ; ) {
    try {
      const now = new Date().toISOString();
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [{ Update: orderTransition(id, from, to, fields, issues) }, ...changes.map((c) => stockUpdate(c, now))],
        }),
      );
      const res = await doc.send(new GetCommand({ TableName: ordersTable(), Key: { id }, ConsistentRead: true }));
      return { order: res.Item as Order, shortfalls };
    } catch (err) {
      const codes = cancellationCodes(err);
      if (!codes) throw err;
      if (codes[0] === 'ConditionalCheckFailed') return undefined;
      const failed = changes.filter((_, i) => codes[i + 1] === 'ConditionalCheckFailed');
      if (failed.length === 0) {
        // Another write touched the same item at the same moment: retry shortly, then give up
        // (the webhook returns 500 and Stripe retries later).
        if (codes.includes('TransactionConflict') && conflicts < CONFLICT_RETRIES) {
          await conflictBackoff(conflicts++);
          continue;
        }
        throw err;
      }
      for (const c of failed) {
        if (c.delta >= 0) continue;
        const product = await getProduct(c.productId);
        if (product && typeof product.stock === 'number') {
          shortfalls.push(c.productId);
          if (c.shortfallIssue) issues.push(c.shortfallIssue);
        }
      }
      changes = changes.filter((c) => !failed.includes(c));
    }
  }
}

/** Records that the order emails were sent. */
export async function markOrderNotified(id: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: ordersTable(),
      Key: { id },
      UpdateExpression: 'SET notifiedAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  );
}

export async function listOrders(status: OrderStatus, limit = 100): Promise<Order[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: ordersTable(),
      IndexName: 'byStatus',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []) as Order[];
}

export async function ping(): Promise<void> {
  await doc.send(new ScanCommand({ TableName: productsTable(), Limit: 1 }));
}
