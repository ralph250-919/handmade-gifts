import type Stripe from 'stripe';
import { env } from '../lib/config.js';
import * as db from '../lib/db.js';
import { emailEnabled, sendEmail } from '../lib/email.js';
import { handleCheckoutEvent, type CheckoutSessionInfo } from '../lib/fulfillment.js';
import { httpHandler, json, rawBody } from '../lib/http.js';
import { countMetric, logger, Metric } from '../lib/observability.js';
import { getStripe, getStripeSecrets } from '../lib/stripe.js';

export function toSessionInfo(s: Stripe.Checkout.Session): CheckoutSessionInfo {
  const ship = s.collected_information?.shipping_details;
  return {
    id: s.id,
    paymentStatus: s.payment_status,
    amountTotal: s.amount_total,
    shippingCents: s.shipping_cost?.amount_total ?? null,
    customerEmail: s.customer_details?.email ?? null,
    customerName: s.customer_details?.name ?? ship?.name ?? null,
    shippingAddress: ship
      ? {
          name: ship.name,
          line1: ship.address?.line1,
          line2: ship.address?.line2,
          city: ship.address?.city,
          state: ship.address?.state,
          postalCode: ship.address?.postal_code,
          country: ship.address?.country,
        }
      : null,
  };
}

/** POST /api/webhooks/stripe — Stripe calls this after payment events. */
export const handler = httpHandler(async (event) => {
  const signature = event.headers['stripe-signature'];
  if (!signature) return json(400, { error: 'Missing signature' });

  const [stripe, secrets] = await Promise.all([getStripe(), getStripeSecrets()]);
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody(event), signature, secrets.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn('Invalid Stripe signature', { error: (err as Error).message });
    countMetric(Metric.WebhookFailed);
    return json(400, { error: 'Invalid signature' });
  }

  logger.appendKeys({ stripeEventId: stripeEvent.id, stripeEventType: stripeEvent.type });
  if (!stripeEvent.type.startsWith('checkout.session.')) return json(200, { received: true, outcome: 'ignored' });

  try {
    const outcome = await handleCheckoutEvent(
      {
        transitionOrder: db.transitionOrder,
        decrementStock: db.decrementStock,
        addOrderIssue: db.addOrderIssue,
        sendEmail,
        metric: countMetric,
        log: (level, message, extra) => logger[level](message, extra ?? {}),
      },
      stripeEvent.type,
      toSessionInfo(stripeEvent.data.object as Stripe.Checkout.Session),
      { shopName: env('SHOP_NAME'), ownerEmail: process.env.OWNER_EMAIL || undefined, siteUrl: env('SITE_URL'), emailEnabled: emailEnabled() },
    );
    return json(200, { received: true, outcome });
  } catch (err) {
    // Returning 500 makes Stripe retry with backoff for up to 3 days.
    countMetric(Metric.WebhookFailed);
    throw err;
  }
});
