import { z } from 'zod';
import { UserFacingError } from './errors.js';
import type { OrderItem, Product } from './types.js';

export const MAX_QUANTITY_PER_ITEM = 20;
export const MAX_LINES = 30;

export const cartSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_ITEM),
      }),
    )
    .min(1, 'Your cart is empty')
    .max(MAX_LINES),
});

export type CartRequest = z.infer<typeof cartSchema>;

export function parseCart(body: unknown): CartRequest {
  const result = cartSchema.safeParse(body);
  if (!result.success) {
    throw new UserFacingError(400, result.error.issues[0]?.message ?? 'Invalid cart', 'INVALID_CART');
  }
  // Merge duplicate lines for the same product.
  const merged = new Map<string, number>();
  for (const item of result.data.items) {
    merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  }
  return { items: [...merged].map(([productId, quantity]) => ({ productId, quantity })) };
}

export interface PricedCart {
  items: OrderItem[];
  subtotalCents: number;
  currency: string;
}

/**
 * Price a cart using the authoritative product records from the database.
 * Never trusts prices sent by the browser.
 */
export function priceCart(cart: CartRequest, products: Map<string, Product>): PricedCart {
  const items: OrderItem[] = [];
  let currency: string | undefined;

  for (const line of cart.items) {
    const product = products.get(line.productId);
    if (!product || !product.active) {
      throw new UserFacingError(409, 'One of the items in your cart is no longer available. Please refresh your cart.', 'UNAVAILABLE');
    }
    if (line.quantity > MAX_QUANTITY_PER_ITEM) {
      throw new UserFacingError(400, `You can order at most ${MAX_QUANTITY_PER_ITEM} of "${product.name}".`, 'QUANTITY');
    }
    if (product.stock !== null && product.stock < line.quantity) {
      const msg =
        product.stock === 0
          ? `Sorry, "${product.name}" just sold out.`
          : `Only ${product.stock} of "${product.name}" left in stock.`;
      throw new UserFacingError(409, msg, 'OUT_OF_STOCK');
    }
    if (currency && product.currency !== currency) {
      throw new UserFacingError(400, 'Items in your cart use different currencies.', 'CURRENCY');
    }
    currency = product.currency;
    items.push({
      productId: product.id,
      name: product.name,
      unitPriceCents: product.priceCents,
      quantity: line.quantity,
    });
  }

  const subtotalCents = items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
  return { items, subtotalCents, currency: currency! };
}

export function shippingCentsFor(subtotalCents: number, standardCents: number, freeOverCents: number): number {
  return freeOverCents > 0 && subtotalCents >= freeOverCents ? 0 : standardCents;
}
