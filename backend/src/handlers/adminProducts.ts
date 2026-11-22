import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as db from '../lib/db.js';
import { UserFacingError } from '../lib/errors.js';
import { adminEmail, httpHandler, json, parseJsonBody } from '../lib/http.js';
import { logger } from '../lib/observability.js';
import { slugify } from '../lib/slug.js';
import type { Product } from '../lib/types.js';

export const productInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000).default(''),
  priceCents: z.number().int().min(50, 'Minimum price is 0.50').max(10_000_00),
  images: z.array(z.string().max(500)).max(10).default([]),
  stock: z.number().int().min(0).max(100_000).nullable().default(null),
  active: z.boolean().default(true),
  category: z.string().trim().max(60).optional(),
  slug: z.string().trim().max(80).optional(),
});

/**
 * Updates also send `baseStock`: the stock shown when the edit form was opened. Checkouts change
 * stock while the form is open, so stock is only written when the admin actually changed it.
 */
export const productUpdateInput = productInput.extend({
  baseStock: z.number().int().min(0).nullable(),
});

function validate<T extends z.ZodTypeAny>(body: unknown, schema: T): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new UserFacingError(400, `${issue?.path.join('.') || 'input'}: ${issue?.message}`, 'INVALID_PRODUCT');
  }
  return r.data;
}

async function uniqueSlug(base: string, selfId?: string): Promise<string> {
  let slug = slugify(base) || 'item';
  for (let n = 2; ; n++) {
    const existing = await db.getProductBySlug(slug);
    if (!existing || existing.id === selfId) return slug;
    slug = `${slugify(base)}-${n}`;
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
    const input = validate(parseJsonBody(event), productInput);
    const now = new Date().toISOString();
    const product: Product = {
      ...input,
      id: randomUUID(),
      slug: await uniqueSlug(input.slug || input.name),
      currency: (process.env.CURRENCY ?? 'usd').toLowerCase(),
      createdAt: now,
      updatedAt: now,
    };
    await db.putProduct(product);
    logger.info('Product created', { productId: product.id, by: who });
    return json(201, product);
  }

  if (!id) throw new UserFacingError(400, 'Missing product id');
  const existing = await db.getProduct(id);
  if (!existing) throw new UserFacingError(404, 'Product not found', 'NOT_FOUND');

  if (method === 'PUT') {
    const { baseStock, ...input } = validate(parseJsonBody(event), productUpdateInput);
    const slug = input.slug && input.slug !== existing.slug ? await uniqueSlug(input.slug, id) : existing.slug;
    const stockEdited = input.stock !== baseStock;
    // Re-read and retry if a checkout changes the product between our read and our write.
    let current: Product | undefined = existing;
    for (let attempt = 0; attempt < 3 && current; attempt++) {
      if (stockEdited && current.stock !== baseStock) {
        throw new UserFacingError(
          409,
          `The stock of "${current.name}" changed to ${current.stock ?? 'made to order'} while you were editing (probably a sale). Check the stock and save again.`,
          'STOCK_CHANGED',
        );
      }
      const product: Product = {
        ...current,
        ...input,
        stock: stockEdited ? input.stock : current.stock,
        slug,
        updatedAt: new Date().toISOString(),
      };
      if (await db.putProductIfUnchanged(product, current.updatedAt)) {
        logger.info('Product updated', { productId: id, by: who, stockEdited });
        return json(200, product);
      }
      current = await db.getProduct(id);
    }
    if (!current) throw new UserFacingError(404, 'Product not found', 'NOT_FOUND');
    throw new UserFacingError(409, 'This product is being bought right now. Please try saving again.', 'BUSY');
  }

  if (method === 'DELETE') {
    await db.deleteProduct(id);
    logger.info('Product deleted', { productId: id, by: who });
    return { statusCode: 204 };
  }

  throw new UserFacingError(405, 'Method not allowed');
});
