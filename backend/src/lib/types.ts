/** Shared domain types for the shop. Prices are always integer minor units (cents). */

export interface Product {
  id: string;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  /** Image paths served by CloudFront, e.g. "/images/products/abc.jpg". */
  images: string[];
  /** null = made to order (no stock limit). */
  stock: number | null;
  /** Hidden products are not shown in the storefront or the catalog feed. */
  active: boolean;
  category?: string;
  createdAt: string;
  updatedAt: string;
}

export type OrderStatus = 'PENDING' | 'PAID' | 'SHIPPED' | 'EXPIRED' | 'CANCELLED';

export interface OrderItem {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
}

export interface ShippingAddress {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface Order {
  /** The Stripe Checkout Session id. */
  id: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotalCents: number;
  shippingCents?: number;
  totalCents?: number;
  currency: string;
  customerEmail?: string;
  customerName?: string;
  shippingAddress?: ShippingAddress;
  trackingNumber?: string;
  carrier?: string;
  /** Problems needing the owner's attention (e.g. sold more than in stock). */
  issues?: string[];
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
  shippedAt?: string;
}
