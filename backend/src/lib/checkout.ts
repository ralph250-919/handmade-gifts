import { parseCart, priceCart, shippingCentsFor } from './cart.js';
import { UserFacingError } from './errors.js';
import type { Order, Product, StockReservation } from './types.js';

/**
 * Stock is held while the customer is on Stripe's page. Stripe's shortest allowed expiry is
 * 30 minutes after it creates the session; the extra minute allows for clock skew and latency.
 */
export const CHECKOUT_EXPIRES_MINUTES = 31;

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
  /** Unix time (seconds) when the session expires and its reserved stock is released. */
  expiresAt: number;
}

export interface CheckoutDeps {
  getProductsByIds(ids: string[]): Promise<Map<string, Product>>;
  createSession(req: SessionRequest): Promise<{ id: string; url: string }>;
  /** Saves the order and takes its reservedStock off the products atomically; returns the id of a product that ran out, if any. */
  createPendingOrder(order: Order): Promise<string | undefined>;
  /** Cancels a session that can't be used. */
  expireSession(id: string): Promise<void>;
}

/**
 * Validates and prices the cart server-side, creates a Stripe Checkout Session,
 * and records a PENDING order keyed by the session id. The order's stock is reserved
 * in the same write, so two customers can't both pay for the last item; it is put
 * back if the checkout expires (see fulfillment.ts).
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
    expiresAt: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRES_MINUTES * 60,
  });

  const reservedStock: StockReservation[] = priced.items
    .filter((i) => products.get(i.productId)?.stock != null)
    .map((i) => ({ productId: i.productId, quantity: i.quantity }));
  const now = new Date().toISOString();
  // The customer never sees this session's URL if saving fails, so cancel it (it would expire on its own anyway).
  const cancelSession = () => deps.expireSession(session.id).catch(() => undefined);
  let soldOut: string | undefined;
  try {
    soldOut = await deps.createPendingOrder({
      id: session.id,
      status: 'PENDING',
      items: priced.items,
      subtotalCents: priced.subtotalCents,
      shippingCents,
      currency: priced.currency,
      reservedStock,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    await cancelSession();
    throw err;
  }
  if (soldOut) {
    await cancelSession();
    const name = products.get(soldOut)?.name ?? 'an item';
    throw new UserFacingError(409, `Someone just bought "${name}" — there aren't enough left for your order. Please check your cart.`, 'OUT_OF_STOCK');
  }

  return { url: session.url, orderId: session.id };
}
