/**
 * Local development server — try the whole shop without AWS or Stripe.
 *   npm run dev   ->  http://localhost:5173  (admin at /admin/, no login needed locally)
 *
 * Serves frontend/ and an in-memory API that reuses the real business logic
 * (cart pricing, checkout, fulfillment, catalog feed). Stripe is simulated by a
 * fake checkout page. Data resets when the server restarts.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCheckout } from '../backend/src/lib/checkout.js';
import { UserFacingError } from '../backend/src/lib/errors.js';
import { buildCatalogCsv } from '../backend/src/lib/feed.js';
import { handleCheckoutEvent } from '../backend/src/lib/fulfillment.js';
import { slugify } from '../backend/src/lib/slug.js';
import type { Order, OrderStatus, Product } from '../backend/src/lib/types.js';
import { toPublic } from '../backend/src/handlers/products.js';
import seed from './seed-data.json' with { type: 'json' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 5173);
const SITE = `http://localhost:${PORT}`;
const settings = { siteUrl: SITE, shopName: 'Handmade Gifts', allowedCountries: ['US'], shippingStandardCents: 600, freeShippingOverCents: 7500 };

const now = () => new Date().toISOString();
const products = new Map<string, Product>();
seed.forEach((s, i) => {
  const id = randomUUID();
  const t = new Date(Date.now() - i * 60_000).toISOString();
  products.set(id, { id, slug: s.slug, name: s.name, description: s.description, priceCents: s.priceCents, stock: s.stock, category: s.category, currency: 'usd', images: [`/images/sample/${s.image}.svg`], active: true, createdAt: t, updatedAt: t });
});
const orders = new Map<string, Order>();
const uploads = new Map<string, { type: string; body: Buffer }>();

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const fulfillmentDeps = {
  async transitionOrder(id: string, from: OrderStatus[], to: OrderStatus, fields: Partial<Order> = {}) {
    const o = orders.get(id);
    if (!o || !from.includes(o.status)) return undefined;
    Object.assign(o, fields, { status: to, updatedAt: now() });
    return { ...o };
  },
  async decrementStock(id: string, q: number) {
    const p = products.get(id);
    if (!p) return false;
    if (p.stock === null) return true;
    if (p.stock < q) return false;
    p.stock -= q;
    return true;
  },
  async addOrderIssue(id: string, issue: string) {
    const o = orders.get(id)!;
    o.issues = [...(o.issues ?? []), issue];
  },
  async sendEmail(msg: { to: string; subject: string; text: string }) {
    console.log(`\n📧 [email to ${msg.to}] ${msg.subject}\n${msg.text}\n`);
  },
  metric(name: string) {
    console.log(`📈 metric ${name}`);
  },
  log(level: string, message: string, extra?: Record<string, unknown>) {
    console.log(`[${level}] ${message}`, extra ?? '');
  },
};

function productInput(body: Record<string, unknown>, existing?: Product): Product {
  const name = String(body.name ?? '').trim();
  if (!name) throw new UserFacingError(400, 'name: Required');
  const priceCents = Number(body.priceCents);
  if (!Number.isInteger(priceCents) || priceCents < 50) throw new UserFacingError(400, 'priceCents: Minimum price is 0.50');
  const t = now();
  return {
    id: existing?.id ?? randomUUID(),
    slug: existing?.slug ?? slugify(name),
    name,
    description: String(body.description ?? ''),
    priceCents,
    currency: 'usd',
    images: (body.images as string[]) ?? [],
    stock: body.stock === null || body.stock === undefined ? null : Number(body.stock),
    active: body.active !== false,
    category: (body.category as string) || undefined,
    createdAt: existing?.createdAt ?? t,
    updatedAt: t,
  };
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const m = req.method!;
  const p = url.pathname;
  const json = async () => JSON.parse((await readBody(req)).toString() || '{}');
  let match: RegExpMatchArray | null;

  if (p === '/api/health') return send(res, 200, { ok: true, checks: { database: true, payments: true } });
  if (p === '/api/products') return send(res, 200, { products: [...products.values()].filter((x) => x.active).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toPublic) });
  if ((match = p.match(/^\/api\/products\/([^/]+)$/))) {
    const prod = [...products.values()].find((x) => x.slug === decodeURIComponent(match![1]!) && x.active);
    return prod ? send(res, 200, toPublic(prod)) : send(res, 404, { error: 'Product not found', code: 'NOT_FOUND' });
  }
  if (p === '/api/feed/catalog.csv') return send(res, 200, buildCatalogCsv([...products.values()], SITE, settings.shopName), 'text/csv');
  if (p === '/api/checkout' && m === 'POST') {
    const result = await startCheckout(
      {
        getProductsByIds: async (ids) => new Map(ids.flatMap((id) => (products.has(id) ? [[id, products.get(id)!] as const] : []))),
        createPendingOrder: async (o) => void orders.set(o.id, o),
        createSession: async () => {
          const id = `cs_dev_${randomUUID().slice(0, 8)}`;
          return { id, url: `${SITE}/dev-checkout?session=${id}` };
        },
      },
      await json(),
      settings,
    );
    return send(res, 200, { url: result.url });
  }
  // Admin (no auth locally)
  if (p === '/api/admin/products' && m === 'GET') return send(res, 200, { products: [...products.values()] });
  if (p === '/api/admin/products' && m === 'POST') {
    const prod = productInput(await json());
    products.set(prod.id, prod);
    return send(res, 201, prod);
  }
  if ((match = p.match(/^\/api\/admin\/products\/([^/]+)$/))) {
    const existing = products.get(match[1]!);
    if (!existing) return send(res, 404, { error: 'Product not found' });
    if (m === 'DELETE') return products.delete(existing.id), send(res, 204, '');
    const prod = productInput(await json(), existing);
    products.set(prod.id, prod);
    return send(res, 200, prod);
  }
  if (p === '/api/admin/orders') {
    const status = url.searchParams.get('status') ?? 'PAID';
    return send(res, 200, { orders: [...orders.values()].filter((o) => o.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }
  if ((match = p.match(/^\/api\/admin\/orders\/([^/]+)\/ship$/))) {
    const o = await fulfillmentDeps.transitionOrder(match[1]!, ['PAID'], 'SHIPPED', { ...(await json()), shippedAt: now() });
    if (!o) return send(res, 409, { error: 'Only paid orders can be marked as shipped' });
    await fulfillmentDeps.sendEmail({ to: o.customerEmail ?? '', subject: 'Your order is on its way', text: `Tracking: ${o.trackingNumber ?? '-'}` });
    return send(res, 200, { order: o, emailed: true });
  }
  if (p === '/api/admin/uploads') {
    const { contentType } = await json();
    const key = `images/products/${randomUUID()}.${String(contentType).split('/')[1]}`;
    return send(res, 200, { uploadUrl: `${SITE}/dev-upload/${key}`, imagePath: `/${key}` });
  }
  return send(res, 404, { error: 'Not found' });
}

const fakeStripePage = (session: string, order?: Order) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test checkout</title>
<body style="font-family:system-ui;max-width:480px;margin:40px auto;padding:0 16px">
<h1>Simulated Stripe Checkout</h1><p>This page stands in for Stripe locally. Total: <b>$${(((order?.subtotalCents ?? 0) + (order?.shippingCents ?? 0)) / 100).toFixed(2)}</b></p>
<form method="post" action="/dev-checkout/pay"><input type="hidden" name="session" value="${session}">
<label>Email <input name="email" value="buyer@example.com"></label><br><br>
<button data-testid="fake-pay" style="padding:12px 20px">Pay (test)</button> <a href="/cart.html?cancelled=1">Cancel</a></form></body>`;

createServer(async (req, res) => {
  const url = new URL(req.url!, SITE);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/config.json')
      return send(res, 200, { apiBase: '', shopName: settings.shopName, currency: 'usd', devAuth: true, shippingStandardCents: settings.shippingStandardCents, freeShippingOverCents: settings.freeShippingOverCents });
    if (url.pathname === '/dev-checkout') {
      const s = url.searchParams.get('session') ?? '';
      return send(res, 200, fakeStripePage(s, orders.get(s)), 'text/html');
    }
    if (url.pathname === '/dev-checkout/pay' && req.method === 'POST') {
      const form = new URLSearchParams((await readBody(req)).toString());
      const id = form.get('session')!;
      const o = orders.get(id);
      await handleCheckoutEvent(fulfillmentDeps, 'checkout.session.completed', {
        id, paymentStatus: 'paid', amountTotal: (o?.subtotalCents ?? 0) + (o?.shippingCents ?? 0), shippingCents: o?.shippingCents ?? 0,
        customerEmail: form.get('email'), customerName: 'Test Buyer',
        shippingAddress: { name: 'Test Buyer', line1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' },
      }, { ...settings, ownerEmail: 'owner@localhost' });
      res.writeHead(303, { location: `/success.html?session_id=${id}` });
      return res.end();
    }
    if (url.pathname.startsWith('/dev-upload/') && req.method === 'PUT') {
      uploads.set('/' + url.pathname.slice('/dev-upload/'.length), { type: req.headers['content-type'] ?? 'application/octet-stream', body: await readBody(req) });
      return send(res, 200, '');
    }
    if (url.pathname.startsWith('/images/sample/'))
      return send(res, 200, await readFile(path.join(root, 'scripts/sample-images', path.basename(url.pathname))), 'image/svg+xml');
    if (uploads.has(url.pathname)) {
      const u = uploads.get(url.pathname)!;
      return send(res, 200, u.body, u.type);
    }
    let file = path.normalize(path.join(root, 'frontend', url.pathname));
    if (!file.startsWith(path.join(root, 'frontend'))) return send(res, 403, 'Forbidden', 'text/plain');
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    try {
      return send(res, 200, await readFile(file), types[path.extname(file)] ?? 'application/octet-stream');
    } catch {
      return send(res, 404, await readFile(path.join(root, 'frontend/404.html')), 'text/html; charset=utf-8');
    }
  } catch (err) {
    if (err instanceof UserFacingError) return send(res, err.statusCode, { error: err.message, code: err.code });
    console.error(err);
    return send(res, 500, { error: 'Internal error (see dev server console)' });
  }
}).listen(PORT, () => console.log(`🛍️  Shop running at ${SITE}  ·  admin: ${SITE}/admin/`));
