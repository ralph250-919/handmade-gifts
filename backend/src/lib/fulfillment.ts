import type { EmailMessage } from './email.js';
import { newOrderOwnerEmail, orderConfirmationEmail } from './email.js';
import type { MetricName } from './observability.js';
import { redactEmails } from './redact.js';
import type { Order, OrderStatus, ShippingAddress, StockChange } from './types.js';

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
  getOrder(id: string): Promise<Order | undefined>;
  /** Atomically changes the order's state and applies the stock changes (see db.transitionOrderWithStock). */
  transitionOrderWithStock(
    id: string,
    from: OrderStatus[],
    to: OrderStatus,
    fields: Partial<Order>,
    stock: StockChange[],
  ): Promise<{ order: Order; shortfalls: string[] } | undefined>;
  markOrderNotified(id: string): Promise<void>;
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

export type WebhookOutcome = 'paid' | 'resumed' | 'duplicate' | 'awaiting-payment' | 'expired' | 'payment-failed' | 'ignored';

/** Puts back the stock that was reserved when checkout started. */
const releaseReserved = (order: Order | undefined): StockChange[] =>
  (order?.reservedStock ?? []).map((r) => ({ productId: r.productId, delta: r.quantity }));

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
      const pending = await deps.getOrder(session.id);
      const res = await deps.transitionOrderWithStock(session.id, ['PENDING'], 'EXPIRED', {}, releaseReserved(pending));
      if (res) deps.metric('CheckoutExpired');
      return res ? 'expired' : 'duplicate';
    }

    case 'checkout.session.async_payment_failed': {
      const pending = await deps.getOrder(session.id);
      const res = await deps.transitionOrderWithStock(session.id, ['PENDING'], 'CANCELLED', {}, releaseReserved(pending));
      if (res) deps.log('warn', 'Async payment failed', { orderId: session.id });
      return res ? 'payment-failed' : 'duplicate';
    }

    default:
      return 'ignored';
  }
}

/**
 * Marks the order paid, then sends the order emails.
 *
 * Every step can be safely retried. If the function fails after the order became PAID
 * (e.g. a timeout while emailing), Stripe retries the webhook and the retry picks up
 * where it stopped, because the emails are only marked as sent (notifiedAt) at the end.
 */
async function markPaid(deps: FulfillmentDeps, session: CheckoutSessionInfo, settings: FulfillmentSettings): Promise<WebhookOutcome> {
  let order = await deps.getOrder(session.id);
  if (!order) {
    // Not one of this shop's checkouts (e.g. another integration on the same Stripe account).
    deps.log('info', 'Order not found', { orderId: session.id });
    return 'duplicate';
  }

  let justPaid = false;
  if (order.status === 'PENDING') {
    // Orders created before stock reservation existed still need their stock taken now.
    const stock: StockChange[] = order.reservedStock
      ? []
      : order.items.map((i) => ({
          productId: i.productId,
          delta: -i.quantity,
          shortfallIssue: `Not enough stock for "${i.name}" (ordered ${i.quantity}). Contact the customer about timing or a refund.`,
        }));
    const res = await deps.transitionOrderWithStock(session.id, ['PENDING'], 'PAID', {
      paidAt: new Date().toISOString(),
      totalCents: session.amountTotal ?? undefined,
      shippingCents: session.shippingCents ?? undefined,
      customerEmail: session.customerEmail ?? undefined,
      customerName: session.customerName ?? session.shippingAddress?.name ?? undefined,
      shippingAddress: session.shippingAddress ?? undefined,
    }, stock);
    if (res) {
      justPaid = true;
      order = res.order;
      deps.metric('CheckoutCompleted');
      deps.metric('OrderRevenueCents', order.totalCents ?? order.subtotalCents);
      deps.log('info', 'Order paid', { orderId: order.id, totalCents: order.totalCents });
      for (const productId of res.shortfalls) {
        deps.metric('StockConflict');
        deps.log('warn', 'Stock conflict', { orderId: order.id, productId });
      }
    } else {
      // Another delivery of this event got there first.
      order = await deps.getOrder(session.id);
      if (!order) return 'duplicate';
    }
  }

  if (order.status !== 'PAID' && order.status !== 'SHIPPED') {
    deps.log('warn', 'Payment event for an order that is not paid', { orderId: order.id, status: order.status });
    return 'duplicate';
  }
  if (order.notifiedAt) {
    deps.log('info', 'Order already processed', { orderId: order.id });
    return justPaid ? 'paid' : 'duplicate';
  }

  if (settings.emailEnabled === false) {
    deps.log('info', 'Order emails are turned off (no sender address configured)', { orderId: order.id });
  } else {
    const emails: EmailMessage[] = [];
    if (order.customerEmail) emails.push(orderConfirmationEmail(order, settings.shopName));
    if (settings.ownerEmail) emails.push(newOrderOwnerEmail(order, settings.ownerEmail, settings.siteUrl));
    for (const [i, msg] of emails.entries()) {
      try {
        await deps.sendEmail(msg);
      } catch (err) {
        // Don't fail the webhook: the order is saved; the alarm tells the owner to follow up.
        // Never log the address itself: SES error messages can contain it too, so scrub them.
        deps.metric('OrderEmailFailed');
        deps.log('error', 'Failed to send order email', {
          orderId: order.id,
          recipient: i === 0 && order.customerEmail ? 'customer' : 'owner',
          error: redactEmails((err as Error).message ?? String(err)),
        });
      }
    }
  }
  await deps.markOrderNotified(order.id);
  return justPaid ? 'paid' : 'resumed';
}
