/**
 * Posts the products in product-drafts/ to the live shop, then checks they appear on the site.
 *
 *   PRODUCTS_TABLE=... IMAGES_BUCKET=... SITE_URL=... npx tsx scripts/post-drafts.ts           # post, then verify
 *   PRODUCTS_TABLE=... SITE_URL=... npx tsx scripts/post-drafts.ts --verify-only                  # verify only
 *
 * Run by .github/workflows/post-products.yml, which resolves those values from the HandmadeGiftsShop stack.
 * A product whose slug already exists is skipped, so re-running it doesn't create duplicates.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { chromium, type Browser } from '@playwright/test';
import { z } from 'zod';
import { env } from '../backend/src/lib/config.js';
import { getProductBySlug, putProduct } from '../backend/src/lib/db.js';

const draftsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'product-drafts');

const listingSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  description: z.string().min(1).max(5000),
  priceCents: z.number().int().positive(),
  // Owner decision: one of each in stock.
  stock: z.literal(1),
  // A bare file name in product-drafts/, never a path.
  image: z.string().regex(/^[a-z0-9-]+\.jpg$/),
});
type Listing = z.infer<typeof listingSchema>;

const listings: Listing[] = z
  .array(listingSchema)
  .min(1)
  .parse(JSON.parse(await readFile(join(draftsDir, 'listings.json'), 'utf8')));
if (new Set(listings.map((l) => l.slug)).size !== listings.length) throw new Error('Duplicate slug in listings.json');

const siteUrl = env('SITE_URL').replace(/\/+$/, '');
if (!/^https:\/\//.test(siteUrl)) throw new Error(`SITE_URL must be an https URL, got ${siteUrl}`);

async function post(): Promise<void> {
  const bucket = env('IMAGES_BUCKET');
  const s3 = new S3Client({});

  // Read everything (and every photo) before writing anything, so a bad file or a missing
  // read permission stops the run before the shop changes.
  const todo: { listing: Listing; photo: Buffer }[] = [];
  for (const listing of listings) {
    if (await getProductBySlug(listing.slug)) {
      console.log(`skip   ${listing.slug} (a product with this slug already exists)`);
      continue;
    }
    const photo = await readFile(join(draftsDir, listing.image));
    if (photo[0] !== 0xff || photo[1] !== 0xd8) throw new Error(`${listing.image} is not a JPEG`);
    todo.push({ listing, photo });
  }

  for (const { listing, photo } of todo) {
    const key = `images/products/${randomUUID()}.jpg`;
    console.log(`upload ${listing.slug} -> /${key}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: photo,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    const now = new Date().toISOString();
    await putProduct({
      id: randomUUID(),
      slug: listing.slug,
      name: listing.name,
      description: listing.description,
      priceCents: listing.priceCents,
      currency: 'usd',
      images: [`/${key}`],
      stock: listing.stock,
      active: true,
      category: listing.category,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`added  ${listing.slug} (/${key})`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Checks one product on the live site, retrying while the 60-second catalog cache expires. */
async function verifyOne(browser: Browser, listing: Listing): Promise<string | undefined> {
  let problem = 'not checked';
  // About 6 attempts over ~1.5 minutes per product keeps the whole run well under the job timeout.
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await sleep(15_000);
    const res = await fetch(`${siteUrl}/api/products/${listing.slug}`);
    if (res.status !== 200) {
      problem = `API returned ${res.status}`;
      continue;
    }
    const p = (await res.json()) as { name?: string; priceCents?: number; available?: boolean; images?: string[] };
    if (p.name !== listing.name || p.priceCents !== listing.priceCents || p.available !== true) {
      problem = `API returned unexpected data: ${JSON.stringify({ name: p.name, priceCents: p.priceCents, available: p.available })}`;
      continue;
    }
    const image = p.images?.[0];
    const img = image ? await fetch(`${siteUrl}${image}`) : undefined;
    if (!img || img.status !== 200 || img.headers.get('content-type') !== 'image/jpeg') {
      problem = `photo ${image ?? '(none)'} returned ${img?.status ?? 'nothing'}`;
      continue;
    }
    // Render the storefront page as a shopper would and check it shows the product.
    const page = await browser.newPage();
    try {
      await page.goto(`${siteUrl}/product.html?slug=${listing.slug}`);
      await page.getByText(listing.name, { exact: true }).first().waitFor({ timeout: 15_000 });
      await page.locator('#add').waitFor({ timeout: 5_000 });
    } catch (err) {
      problem = `product page did not show the product (${(err as Error).message.split('\n')[0]})`;
      continue;
    } finally {
      await page.close();
    }
    return undefined;
  }
  return problem;
}

async function verify(): Promise<void> {
  let failed = 0;
  const browser = await chromium.launch();
  for (const listing of listings) {
    const problem = await verifyOne(browser, listing).catch((err: Error) => `check failed: ${err.message}`);
    if (problem) {
      failed++;
      console.log(`FAIL   ${listing.slug}: ${problem}`);
    } else {
      console.log(`ok     ${listing.slug}  ${siteUrl}/product.html?slug=${listing.slug}`);
    }
  }
  await browser.close();
  if (failed) throw new Error(`${failed} of ${listings.length} products are not showing correctly on the site`);
}

if (!process.argv.includes('--verify-only')) await post();
await verify();
