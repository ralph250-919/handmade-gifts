import type { EmailMessage } from './email.js';
import { newOrderOwnerEmail, orderConfirmationEmail } from './email.js';
import type { MetricName } from './observability.js';
import { Transitions } from './orders.js';
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

/** Result of taking one order line's quantity out of stock. */
export type StockResult = 'reserved' | 'already-handled' | 'insufficient' | 'missing';

export interface FulfillmentDeps {
  transitionOrder(id: string, from: readonly OrderStatus[], to: OrderStatus, fields?: Partial<Order>): Promise<Order | undefined>;
  getOrder(id: string): Promise<Order | undefined>;
  /**
   * Takes `quantity` of a product out of stock for an order, at most once per
   * order + product (the order remembers which lines it has handled).
   */
  reserveStock(orderId: string, productId: string, quantity: number): Promise<StockResult>;
  /** Records a stock problem for one order line, at most once per order + product. */
  flagStockIssue(orderId: string, productId: string, issue: string): Promise<boolean>;
  /** Marks the order's follow-up work (stock + emails) as finished. */
  markFulfilled(id: string): Promise<void>;
  sendEmail(msg: EmailMessage): Promise<void>;
  metric(name: MetricName, value?: number): void;
  log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
}

export interface FulfillmentSettings {
  shopName: string;
  ownerEmail?: string;
  /** false when no sender address is configured: emails are skipped, not counted as failures. */
  emailEnabled?: boolean;
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
      const order = await deps.transitionOrder(session.id, Transitions.expire.from, Transitions.expire.to);
      if (order) deps.metric('CheckoutExpired');
      return order ? 'expired' : 'duplicate';
    }

    case 'checkout.session.async_payment_failed': {
      const order = await deps.transitionOrder(session.id, Transitions.failPayment.from, Transitions.failPayment.to);
      if (order) deps.log('warn', 'Async payment failed', { orderId: session.id });
      return order ? 'payment-failed' : 'duplicate';
    }

    default:
      return 'ignored';
  }
}

/**
 * Marks an order paid, then takes its items out of stock and sends the emails.
 *
 * Every step after the PAID transition can be resumed: if one throws, the
 * webhook returns 500, Stripe retries, and the retry finds the order PAID but
 * not yet fulfilled and carries on where the last attempt stopped. Stock is
 * recorded per order line, so a retry never takes the same line out twice.
 * Emails are sent before the order is marked fulfilled, so a crash between the
 * two can send them twice, but they are never skipped.
 */
async function markPaid(deps: FulfillmentDeps, session: CheckoutSessionInfo, settings: FulfillmentSettings): Promise<WebhookOutcome> {
  let order = await deps.transitionOrder(session.id, Transitions.pay.from, Transitions.pay.to, {
    paidAt: new Date().toISOString(),
    fulfilment: 'pending',
    totalCents: session.amountTotal ?? undefined,
    shippingCents: session.shippingCents ?? undefined,
    customerEmail: session.customerEmail ?? undefined,
    customerName: session.customerName ?? undefined,
    shippingAddress: session.shippingAddress ?? undefined,
  });

  if (order) {
    deps.metric('CheckoutCompleted');
    deps.metric('OrderRevenueCents', order.totalCents ?? order.subtotalCents);
    deps.log('info', 'Order paid', { orderId: order.id, totalCents: order.totalCents });
  } else {
    order = await deps.getOrder(session.id);
    if (!order || order.status !== 'PAID' || order.fulfilment !== 'pending') {
      // Already processed (Stripe retries webhooks) or unknown order.
      deps.log('info', 'Order already processed or not found', { orderId: session.id });
      return 'duplicate';
    }
    deps.log('warn', 'Resuming fulfilment of a paid order after an earlier failure', { orderId: order.id });
  }

  for (const item of order.items) {
    const result = await deps.reserveStock(order.id, item.productId, item.quantity);
    if (result === 'reserved' || result === 'already-handled') continue;
    const issue =
      result === 'missing'
        ? `"${item.name}" (ordered ${item.quantity}) was deleted from the shop before this order was paid, so its stock was not updated. Check you can still make it, or refund the customer.`
        : `Not enough stock for "${item.name}" (ordered ${item.quantity}). Contact the customer about timing or a refund.`;
    if (await deps.flagStockIssue(order.id, item.productId, issue)) {
      if (result === 'insufficient') deps.metric('StockConflict');
      deps.log('warn', result === 'missing' ? 'Paid order references a deleted product' : 'Stock conflict', {
        orderId: order.id,
        productId: item.productId,
      });
    }
  }

  if (settings.emailEnabled === false) {
    deps.log('info', 'Order emails are turned off (no sender address configured)', { orderId: order.id });
  } else {
    await sendOrderEmails(deps, order, settings);
  }
  await deps.markFulfilled(order.id);
  return 'paid';
}

async function sendOrderEmails(deps: FulfillmentDeps, order: Order, settings: FulfillmentSettings): Promise<void> {
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
}
