import { UserFacingError } from '../lib/errors.js';
import { httpHandler, json } from '../lib/http.js';
import * as db from '../lib/db.js';
import type { Product } from '../lib/types.js';

/** Public fields only (stock is shown as availability, not exact counts above a threshold). */
export function toPublic(p: Product) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    currency: p.currency,
    images: p.images,
    category: p.category,
    available: p.stock === null || p.stock > 0,
    lowStock: p.stock !== null && p.stock > 0 && p.stock <= 3 ? p.stock : undefined,
    madeToOrder: p.stock === null,
  };
}

const CACHE = { 'cache-control': 'public, max-age=60' };

/** GET /api/products and GET /api/products/{slug} */
export const handler = httpHandler(async (event) => {
  const slug = event.pathParameters?.slug;
  if (slug) {
    const product = await db.getProductBySlug(slug);
    if (!product || !product.active) throw new UserFacingError(404, 'Product not found', 'NOT_FOUND');
    return json(200, toPublic(product), CACHE);
  }
  const products = await db.listProducts();
  return json(200, { products: products.map(toPublic) }, CACHE);
});
