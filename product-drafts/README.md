# Product drafts waiting to be posted

Four new products, approved by the shop owner, ready to add to the **live** shop. They aren't part of the site build: nothing in this folder is deployed.

| Product | Category | Price | Stock | Photo |
|---|---|---|---|---|
| Felt Daisy Bouquet (5 stems) | Felt Flowers | $42 | 1 | `felt-daisy-bouquet.jpg` |
| Blush Felt Rose Kissing Ball | Felt Flowers | $72 | 1 | `blush-felt-rose-kissing-ball.jpg` |
| Champagne Crystal Beaded Tassel | Ornaments | $31 | 1 | `champagne-crystal-beaded-tassel.jpg` |
| Striped Hat Gnome with Felt Rose | Gnomes | $90 | 1 | `striped-hat-gnome-with-felt-rose.jpg` |

Names, slugs, descriptions and prices in cents are in `listings.json`. Photos are already resized for the web (max 1200 × 1600 JPEG).

## How to post them

Owner decisions: post as **visible** (`active: true`), one of each in stock (`stock: 1`), currency `usd`.

With AWS access (the AWS connector):

1. Find the `HandmadeGiftsShop` CloudFormation stack (check every region). Its outputs give `ProductsTable` and `SiteUrl`; the images bucket is the stack's `AWS::S3::Bucket` resource whose logical id starts with `StorageImages`.
2. Upload each photo to the images bucket at `images/products/<uuid>.jpg`, with `ContentType: image/jpeg` and `CacheControl: public, max-age=31536000, immutable` (the same as admin uploads in `backend/src/handlers/uploads.ts`).
3. For each listing, check the `bySlug` index first so you don't create duplicates, then put an item shaped like `Product` in `backend/src/lib/types.ts`:
   `id` (new UUID), `slug`, `name`, `description`, `priceCents`, `currency: "usd"`, `images: ["/images/products/<uuid>.jpg"]`, `stock: 1`, `active: true`, `category`, and `createdAt`/`updatedAt` set to the current ISO time.
4. Check each product at `<SiteUrl>/api/products/<slug>` and `<SiteUrl>/product.html?slug=<slug>`. The catalog is cached for up to 60 seconds.

Without AWS access, the owner can add them by hand at `<SiteUrl>/admin/` (Products → Add product) using this table, `listings.json` and the photos.

After they're posted, this folder can be deleted.
