import { env } from '../lib/config.js';
import * as db from '../lib/db.js';
import { buildCatalogCsv } from '../lib/feed.js';
import { httpHandler } from '../lib/http.js';

/** GET /api/feed/catalog.csv — Meta Commerce (Instagram Shopping) product feed. */
export const handler = httpHandler(async () => {
  const csv = buildCatalogCsv(await db.listProducts(), env('SITE_URL'), env('SHOP_NAME'));
  return { statusCode: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'public, max-age=900' }, body: csv };
});
