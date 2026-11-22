import type { EmailMessage } from './email.js';
import { newOrderOwnerEmail, orderConfirmationEmail } from './email.js';
import type { MetricName } from './observability.js';
import { redactEmails } from './redact.js';
import type { Order, OrderItem, OrderStatus, ShippingAddress } from './types.js';

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

export interface PaidOrder {
  order: Order;
  /** Items there was not enough stock for (or whose product was deleted). They are listed in order.issues. */
  stockConflicts: OrderItem[];
}

export interface FulfillmentDeps {
  transitionOrder(id: string, from: OrderStatus[], to: OrderStatus, fields?: Partial<Order>): Promise<Order | undefined>;
  /**
   * In ONE atomic write: moves a PENDING order to PAID with `fields`, takes the ordered quantities off
   * stock, and records an issue (text from `issueFor`) for every item that couldn't be taken from stock.
   * Returns undefined if the order is not PENDING (already processed, or unknown). Because nothing is
   * written unless everything is, a failure part-way leaves the order PENDING and Stripe's retry redoes it.
   */
  markOrderPaid(id: string, fields: Partial<Order>, issueFor: (item: OrderItem) => string): Promise<PaidOrder | undefined>;
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

export const stockConflictIssue = (item: OrderItem) =>
  `Not enough stock for "${item.name}" (ordered ${item.quantity}). Contact the customer about timing or a refund.`;

async function markPaid(deps: FulfillmentDeps, session: CheckoutSessionInfo, settings: FulfillmentSettings): Promise<WebhookOutcome> {
  const now = new Date().toISOString();
  const result = await deps.markOrderPaid(
    session.id,
    {
      paidAt: now,
      totalCents: session.amountTotal ?? undefined,
      shippingCents: session.shippingCents ?? undefined,
      customerEmail: session.customerEmail ?? undefined,
      customerName: session.customerName ?? session.shippingAddress?.name ?? undefined,
      shippingAddress: session.shippingAddress ?? undefined,
    },
    stockConflictIssue,
  );
  if (!result) {
    // Already processed (Stripe retries webhooks) or unknown order.
    deps.log('info', 'Order already processed or not found', { orderId: session.id });
    return 'duplicate';
  }
  const { order, stockConflicts } = result;

  deps.metric('CheckoutCompleted');
  deps.metric('OrderRevenueCents', order.totalCents ?? order.subtotalCents);
  deps.log('info', 'Order paid', { orderId: order.id, totalCents: order.totalCents });
  for (const item of stockConflicts) {
    deps.metric('StockConflict');
    deps.log('warn', 'Stock conflict', { orderId: order.id, productId: item.productId });
  }

  if (settings.emailEnabled === false) {
    deps.log('info', 'Order emails are turned off (no sender address configured)', { orderId: order.id });
    return 'paid';
  }
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
  return 'paid';
}
