import type Stripe from 'stripe';
import { startCheckout } from '../lib/checkout.js';
import { env, envInt, envList } from '../lib/config.js';
import * as db from '../lib/db.js';
import { UserFacingError } from '../lib/errors.js';
import { httpHandler, json, parseJsonBody } from '../lib/http.js';
import { countMetric, logger, Metric } from '../lib/observability.js';
import { getStripe } from '../lib/stripe.js';

/** POST /api/checkout  { items: [{ productId, quantity }] } -> { url } */
export const handler = httpHandler(async (event) => {
  countMetric(Metric.CheckoutStarted);
  try {
    const result = await startCheckout(
      {
        getProductsByIds: db.getProductsByIds,
        createPendingOrder: db.createPendingOrder,
        async createSession(req) {
          const stripe = await getStripe();
          const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: req.lineItems.map((li) => ({
              quantity: li.quantity,
              price_data: {
                currency: req.currency,
                unit_amount: li.unitAmount,
                product_data: { name: li.name, images: li.imageUrl ? [li.imageUrl] : undefined, metadata: { productId: li.productId } },
              },
            })),
            shipping_address_collection: {
              allowed_countries: req.allowedCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
            },
            shipping_options: [
              {
                shipping_rate_data: {
                  type: 'fixed_amount',
                  display_name: req.shippingCents === 0 ? 'Free shipping' : 'Standard shipping',
                  fixed_amount: { amount: req.shippingCents, currency: req.currency },
                },
              },
            ],
            phone_number_collection: { enabled: false },
            success_url: req.successUrl,
            cancel_url: req.cancelUrl,
          });
          if (!session.url) throw new Error('Stripe did not return a checkout URL');
          return { id: session.id, url: session.url };
        },
      },
      parseJsonBody(event),
      {
        siteUrl: env('SITE_URL'),
        shopName: env('SHOP_NAME'),
        allowedCountries: envList('ALLOWED_COUNTRIES', ['US']),
        shippingStandardCents: envInt('SHIPPING_STANDARD_CENTS', 600),
        freeShippingOverCents: envInt('FREE_SHIPPING_OVER_CENTS', 0),
      },
    );
    logger.info('Checkout session created', { orderId: result.orderId });
    return json(200, { url: result.url });
  } catch (err) {
    // Customer-caused problems (sold out, empty cart) vs. our failures (Stripe down, misconfig).
    countMetric(err instanceof UserFacingError ? Metric.CheckoutRejected : Metric.CheckoutFailed);
    if (!(err instanceof UserFacingError)) {
      // Record the real cause (e.g. a Stripe error) before hiding it behind a friendly message.
      const e = err as Error & { type?: string; code?: string; statusCode?: number; requestId?: string };
      logger.error('Checkout failed', {
        error: { name: e.name, message: e.message, stack: e.stack },
        stripe: e.type ? { type: e.type, code: e.code, statusCode: e.statusCode, requestId: e.requestId } : undefined,
      });
      throw new UserFacingError(502, "We couldn't start checkout right now. Please try again in a minute — your cart is saved.", 'CHECKOUT_UNAVAILABLE');
    }
    throw err;
  }
});
