import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as db from '../lib/db.js';
import { UserFacingError } from '../lib/errors.js';
import { adminEmail, httpHandler, json, parseJsonBody } from '../lib/http.js';
import { logger } from '../lib/observability.js';
import { slugify } from '../lib/slug.js';
import type { Product } from '../lib/types.js';

/** Highest price an admin can set, in cents ($10,000). */
const MAX_PRICE_CENTS = 1_000_000;

/** Product fields without defaults, shared by create (POST) and update (PUT). */
const productFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000),
  priceCents: z.number().int().min(50, 'Minimum price is 0.50').max(MAX_PRICE_CENTS),
  images: z.array(z.string().max(500)).max(10),
  stock: z.number().int().min(0).max(100_000).nullable(),
  active: z.boolean(),
  // null or '' clears the category.
  category: z.string().trim().max(60).nullable(),
  slug: z.string().trim().max(80),
});

/** POST: name and price are required; everything else falls back to a default. */
export const productInput = productFields.extend({
  description: productFields.shape.description.default(''),
  images: productFields.shape.images.default([]),
  stock: productFields.shape.stock.default(null),
  active: productFields.shape.active.default(true),
  category: productFields.shape.category.optional(),
  slug: productFields.shape.slug.optional(),
});

/** PUT: only the fields sent are changed. No defaults, so a partial update can't reset other fields. */
export const productUpdate = productFields.partial();

function validate<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new UserFacingError(400, `${issue?.path.join('.') || 'input'}: ${issue?.message}`, 'INVALID_PRODUCT');
  }
  return r.data;
}

type ProductUpdate = z.infer<typeof productUpdate>;

/**
 * Copies validated input onto `base`. `slug` is skipped (callers pick a unique
 * one) and a null or empty category removes the category.
 */
function withInput<T extends object, I extends ProductUpdate>(base: T, input: I) {
  const { category, slug: _slug, ...fields } = input;
  const product = { ...base, ...fields } as T & Omit<I, 'category' | 'slug'> & { category?: string };
  if (category) product.category = category;
  else if (category !== undefined) delete product.category;
  return product;
}

const MAX_SLUG_LENGTH = 80;

export async function uniqueSlug(base: string, selfId?: string, lookup = db.getProductBySlug): Promise<string> {
  // Leave room for a "-NN" suffix so suffixed slugs stay within the limit.
  const root = slugify(base).slice(0, MAX_SLUG_LENGTH - 4).replace(/-+$/, '') || 'item';
  let slug = root;
  for (let n = 2; ; n++) {
    const existing = await lookup(slug);
    if (!existing || existing.id === selfId) return slug;
    slug = `${root}-${n}`;
  }
}

/**
 * Admin product management (Cognito-protected routes):
 *   GET    /api/admin/products
 *   POST   /api/admin/products
 *   PUT    /api/admin/products/{id}
 *   DELETE /api/admin/products/{id}
 */
export const handler = httpHandler(async (event) => {
  const id = event.pathParameters?.id;
  const method = event.requestContext.http.method;
  const who = adminEmail(event);

  if (method === 'GET') {
    return json(200, { products: await db.listProducts({ includeInactive: true }) });
  }

  if (method === 'POST') {
    const input = validate(productInput, parseJsonBody(event));
    const now = new Date().toISOString();
    const product: Product = withInput(
      {
        id: randomUUID(),
        slug: await uniqueSlug(input.slug || input.name),
        currency: (process.env.CURRENCY ?? 'usd').toLowerCase(),
        createdAt: now,
        updatedAt: now,
      },
      input,
    );
    await db.putProduct(product);
    logger.info('Product created', { productId: product.id, by: who });
    return json(201, product);
  }

  if (!id) throw new UserFacingError(400, 'Missing product id');
  const existing = await db.getProduct(id);
  if (!existing) throw new UserFacingError(404, 'Product not found', 'NOT_FOUND');

  if (method === 'PUT') {
    const input = validate(productUpdate, parseJsonBody(event));
    const product: Product = withInput(
      {
        ...existing,
        slug: input.slug && input.slug !== existing.slug ? await uniqueSlug(input.slug, id) : existing.slug,
        updatedAt: new Date().toISOString(),
      },
      input,
    );
    await db.putProduct(product);
    logger.info('Product updated', { productId: id, by: who });
    return json(200, product);
  }

  if (method === 'DELETE') {
    await db.deleteProduct(id);
    logger.info('Product deleted', { productId: id, by: who });
    return { statusCode: 204 };
  }

  throw new UserFacingError(405, 'Method not allowed');
});
