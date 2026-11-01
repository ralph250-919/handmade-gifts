import type { EmailMessage } from './email.js';
import { newOrderOwnerEmail, orderConfirmationEmail } from './email.js';
import type { MetricName } from './observability.js';
import type { Order, OrderStatus, ShippingAddress } from './types.js';

/** The subset of a Stripe Checkout Session that fulfillment needs. */
export interface CheckoutSessionInfo {
  id: string;
  paymentStatus: string;
  amountTotal: number | null;
  shippingCents: number | null;
  customerEmail: string | null;
  customerName: string | null;
  shippingAddress: ShippingAddress | null;
}

export interface FulfillmentDeps {
  transitionOrder(id: string, from: OrderStatus[], to: OrderStatus, fields?: Partial<Order>): Promise<Order | undefined>;
  decrementStock(productId: string, quantity: number): Promise<boolean>;
  addOrderIssue(id: string, issue: string): Promise<void>;
  sendEmail(msg: EmailMessage): Promise<void>;
  metric(name: MetricName, value?: number): void;
  log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
}

export interface FulfillmentSettings {
  shopName: string;
  ownerEmail?: string;
  siteUrl: string;
}

export type WebhookOutcome = 'paid' | 'duplicate' | 'awaiting-payment' | 'expired' | 'payment-failed' | 'ignored';

export async function handleCheckoutEvent(
  deps: FulfillmentDeps,
  type: string,
  session: CheckoutSessionInfo,
  settings: FulfillmentSettings,
): Promise<WebhookOutcome> {
  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (session.paymentStatus !== 'paid' && session.paymentStatus !== 'no_payment_required') {
        // e.g. bank transfers: wait for async_payment_succeeded.
        deps.log('info', 'Checkout completed, payment pending', { orderId: session.id });
        return 'awaiting-payment';
      }
      return markPaid(deps, session, settings);

    case 'checkout.session.expired': {
      const order = await deps.transitionOrder(session.id, ['PENDING'], 'EXPIRED');
      if (order) deps.metric('CheckoutExpired');
      return order ? 'expired' : 'duplicate';
    }

    case 'checkout.session.async_payment_failed': {
      const order = await deps.transitionOrder(session.id, ['PENDING'], 'CANCELLED');
      if (order) deps.log('warn', 'Async payment failed', { orderId: session.id });
      return order ? 'payment-failed' : 'duplicate';
    }

    default:
      return 'ignored';
  }
}

async function markPaid(deps: FulfillmentDeps, session: CheckoutSessionInfo, settings: FulfillmentSettings): Promise<WebhookOutcome> {
  const now = new Date().toISOString();
  const order = await deps.transitionOrder(session.id, ['PENDING'], 'PAID', {
    paidAt: now,
    totalCents: session.amountTotal ?? undefined,
    shippingCents: session.shippingCents ?? undefined,
    customerEmail: session.customerEmail ?? undefined,
    customerName: session.customerName ?? session.shippingAddress?.name ?? undefined,
    shippingAddress: session.shippingAddress ?? undefined,
  });
  if (!order) {
    // Already processed (Stripe retries webhooks) or unknown order.
    deps.log('info', 'Order already processed or not found', { orderId: session.id });
    return 'duplicate';
  }

  deps.metric('CheckoutCompleted');
  deps.metric('OrderRevenueCents', order.totalCents ?? order.subtotalCents);
  deps.log('info', 'Order paid', { orderId: order.id, totalCents: order.totalCents });

  for (const item of order.items) {
    const ok = await deps.decrementStock(item.productId, item.quantity);
    if (!ok) {
      const issue = `Not enough stock for "${item.name}" (ordered ${item.quantity}). Contact the customer about timing or a refund.`;
      deps.metric('StockConflict');
      deps.log('warn', 'Stock conflict', { orderId: order.id, productId: item.productId });
      await deps.addOrderIssue(order.id, issue);
    }
  }

  const emails: EmailMessage[] = [];
  if (order.customerEmail) emails.push(orderConfirmationEmail(order, settings.shopName));
  if (settings.ownerEmail) emails.push(newOrderOwnerEmail(order, settings.ownerEmail, settings.siteUrl));
  for (const msg of emails) {
    try {
      await deps.sendEmail(msg);
    } catch (err) {
      // Don't fail the webhook: the order is saved; the alarm tells the owner to follow up.
      deps.metric('OrderEmailFailed');
      deps.log('error', 'Failed to send order email', { orderId: order.id, to: msg.to, error: (err as Error).message });
    }
  }
  return 'paid';
}
