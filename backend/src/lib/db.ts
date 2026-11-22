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
import { tracer } from './observability.js';
import type { PaidOrder } from './fulfillment.js';
import type { Order, OrderItem, OrderStatus, Product } from './types.js';

const doc = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), {
  marshallOptions: { removeUndefinedValues: true },
});

const productsTable = () => env('PRODUCTS_TABLE');
const ordersTable = () => env('ORDERS_TABLE');

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
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

/** Builds `SET #f0 = :v0, ...` for the given fields (undefined values and the key are skipped). */
function setExpression(fields: Record<string, unknown>) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts = Object.entries(fields)
    .filter(([k, v]) => k !== 'id' && v !== undefined)
    .map(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      return `#f${i} = :v${i}`;
    });
  return { expression: `SET ${parts.join(', ')}`, names, values };
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
  const { expression, names, values } = setExpression({ ...fields, status: to, updatedAt: new Date().toISOString() });
  from.forEach((s, i) => (values[`:from${i}`] = s));
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: ordersTable(),
        Key: { id },
        UpdateExpression: expression,
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

type CancellationReason = { Code?: string };

/**
 * Records a payment in ONE DynamoDB transaction: order PENDING -> PAID, stock taken off every
 * stock-tracked product, and an issue noted on the order for each item that couldn't be taken.
 * Either all of it is written or none of it, so a failure part-way leaves the order PENDING and the
 * next Stripe retry starts again cleanly (no lost stock decrements, no double decrements).
 * Returns undefined when the order isn't PENDING (a duplicate delivery, or an unknown order).
 */
export async function markOrderPaid(
  id: string,
  fields: Partial<Order>,
  issueFor: (item: OrderItem) => string,
): Promise<PaidOrder | undefined> {
  const order = await getOrder(id);
  if (!order || order.status !== 'PENDING') return undefined;
  const products = await getProductsByIds(order.items.map((i) => i.productId));
  // Products that are gone, or that turn out not to have enough stock, become order issues.
  const conflicts = new Set(order.items.filter((i) => !products.has(i.productId)).map((i) => i.productId));

  // Each attempt can discover more sold-out products, so allow one attempt per product plus a few for conflicts.
  const maxAttempts = new Set(order.items.map((i) => i.productId)).size + 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const take = new Map<string, number>();
    for (const item of order.items) {
      const product = products.get(item.productId);
      if (!product || product.stock === null || conflicts.has(item.productId)) continue; // null = made to order
      take.set(item.productId, (take.get(item.productId) ?? 0) + item.quantity);
    }
    const stockConflicts = order.items.filter((i) => conflicts.has(i.productId));
    const now = new Date().toISOString();
    const set: Partial<Order> = { ...fields, status: 'PAID', updatedAt: now };
    if (stockConflicts.length) set.issues = [...(order.issues ?? []), ...stockConflicts.map(issueFor)];
    const { expression, names, values } = setExpression(set);
    const stockIds = [...take.keys()];

    try {
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: ordersTable(),
                Key: { id },
                UpdateExpression: expression,
                ConditionExpression: '#status = :pending',
                ExpressionAttributeNames: { ...names, '#status': 'status' },
                ExpressionAttributeValues: { ...values, ':pending': 'PENDING' },
              },
            },
            ...stockIds.map((productId) => ({
              Update: {
                TableName: productsTable(),
                Key: { id: productId },
                UpdateExpression: 'SET stock = stock - :q, updatedAt = :now',
                ConditionExpression: 'stock >= :q',
                ExpressionAttributeValues: { ':q': take.get(productId)!, ':now': now },
              },
            })),
          ],
        }),
      );
      const written = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined));
      return { order: { ...order, ...written } as Order, stockConflicts };
    } catch (err) {
      if ((err as { name?: string }).name !== 'TransactionCanceledException') throw err;
      const reasons = ((err as { CancellationReasons?: CancellationReason[] }).CancellationReasons ?? []);
      if (reasons[0]?.Code === 'ConditionalCheckFailed') return undefined; // someone else already processed it
      const conflict = reasons.some((r) => r.Code === 'TransactionConflict');
      let retry = conflict;
      reasons.slice(1).forEach((r, i) => {
        if (r.Code === 'ConditionalCheckFailed') {
          conflicts.add(stockIds[i]!); // not enough stock: record an issue instead and try again
          retry = true;
        }
      });
      if (!retry) throw err;
      // Another checkout touched the same product at the same moment: wait briefly before trying again.
      if (conflict) await new Promise((r) => setTimeout(r, (attempt + 1) * 25 + Math.random() * 50));
    }
  }
  throw new Error(`Could not record payment for order ${id} after several attempts`);
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
