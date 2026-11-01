import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { env } from './config.js';
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

/** Atomically reduces stock. Returns false if there was not enough stock. Made-to-order items (stock null) always succeed. */
export async function decrementStock(productId: string, quantity: number): Promise<boolean> {
  const product = await getProduct(productId);
  if (!product) return false;
  if (product.stock === null) return true;
  try {
    await doc.send(
      new UpdateCommand({
        TableName: productsTable(),
        Key: { id: productId },
        UpdateExpression: 'SET stock = stock - :q, updatedAt = :now',
        ConditionExpression: 'stock >= :q',
        ExpressionAttributeValues: { ':q': quantity, ':now': new Date().toISOString() },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
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
  from: OrderStatus[],
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

export async function addOrderIssue(id: string, issue: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: ordersTable(),
      Key: { id },
      UpdateExpression: 'SET issues = list_append(if_not_exists(issues, :empty), :issue)',
      ExpressionAttributeValues: { ':issue': [issue], ':empty': [] },
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
