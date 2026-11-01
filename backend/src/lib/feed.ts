import type { Product } from './types.js';

/**
 * Builds a product catalog CSV in the Meta (Facebook/Instagram) Commerce format.
 * Point a Meta Commerce Manager "data feed" at /api/feed/catalog.csv to enable
 * Instagram Shopping product tags.
 * https://www.facebook.com/business/help/120325381656392
 */
export function buildCatalogCsv(products: Product[], siteUrl: string, brand: string): string {
  const header = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'additional_image_link', 'brand', 'product_type'];
  const rows = products
    .filter((p) => p.active && p.images.length > 0)
    .map((p) => [
      p.id,
      p.name,
      p.description,
      p.stock === 0 ? 'out of stock' : 'in stock',
      'new',
      `${(p.priceCents / 100).toFixed(2)} ${p.currency.toUpperCase()}`,
      `${siteUrl}/product.html?slug=${encodeURIComponent(p.slug)}`,
      absolute(siteUrl, p.images[0]!),
      p.images.slice(1, 10).map((i) => absolute(siteUrl, i)).join(','),
      brand,
      p.category ?? '',
    ]);
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

function absolute(siteUrl: string, path: string): string {
  return /^https?:\/\//.test(path) ? path : `${siteUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

export function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
