/**
 * Loads the sample products into your deployed DynamoDB table.
 *   PRODUCTS_TABLE=<ProductsTable output> npm run seed
 * Photos are not included — add real photos in the admin page afterwards.
 */
import { randomUUID } from 'node:crypto';
import { putProduct, listProducts } from '../backend/src/lib/db.js';
import seed from './seed-data.json' with { type: 'json' };

const existing = new Set((await listProducts({ includeInactive: true })).map((p) => p.slug));
const currency = (process.env.CURRENCY ?? 'usd').toLowerCase();
for (const s of seed) {
  if (existing.has(s.slug)) {
    console.log(`skip  ${s.slug} (already exists)`);
    continue;
  }
  const t = new Date().toISOString();
  await putProduct({ id: randomUUID(), slug: s.slug, name: s.name, description: s.description, priceCents: s.priceCents, stock: s.stock, category: s.category, currency, images: [], active: false, createdAt: t, updatedAt: t });
  console.log(`added ${s.slug} (hidden until you add photos and tick "Visible")`);
}
