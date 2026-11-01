import { parseCart, priceCart, shippingCentsFor } from './cart.js';
import type { Order, Product } from './types.js';

export interface CheckoutSettings {
  siteUrl: string;
  shopName: string;
  allowedCountries: string[];
  shippingStandardCents: number;
  freeShippingOverCents: number;
}

export interface SessionRequest {
  currency: string;
  lineItems: { name: string; unitAmount: number; quantity: number; imageUrl?: string; productId: string }[];
  shippingCents: number;
  allowedCountries: string[];
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutDeps {
  getProductsByIds(ids: string[]): Promise<Map<string, Product>>;
  createSession(req: SessionRequest): Promise<{ id: string; url: string }>;
  createPendingOrder(order: Order): Promise<void>;
}

/**
 * Validates and prices the cart server-side, creates a Stripe Checkout Session,
 * and records a PENDING order keyed by the session id.
 */
export async function startCheckout(deps: CheckoutDeps, body: unknown, settings: CheckoutSettings): Promise<{ url: string; orderId: string }> {
  const cart = parseCart(body);
  const products = await deps.getProductsByIds(cart.items.map((i) => i.productId));
  const priced = priceCart(cart, products);
  const shippingCents = shippingCentsFor(priced.subtotalCents, settings.shippingStandardCents, settings.freeShippingOverCents);

  const session = await deps.createSession({
    currency: priced.currency,
    lineItems: priced.items.map((i) => {
      const image = products.get(i.productId)?.images[0];
      return {
        productId: i.productId,
        name: i.name,
        unitAmount: i.unitPriceCents,
        quantity: i.quantity,
        imageUrl: image ? (image.startsWith('http') ? image : `${settings.siteUrl}${image}`) : undefined,
      };
    }),
    shippingCents,
    allowedCountries: settings.allowedCountries,
    successUrl: `${settings.siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${settings.siteUrl}/cart.html?cancelled=1`,
  });

  const now = new Date().toISOString();
  await deps.createPendingOrder({
    id: session.id,
    status: 'PENDING',
    items: priced.items,
    subtotalCents: priced.subtotalCents,
    shippingCents,
    currency: priced.currency,
    createdAt: now,
    updatedAt: now,
  });

  return { url: session.url, orderId: session.id };
}
