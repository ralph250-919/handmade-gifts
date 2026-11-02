/**
 * Proves the Stripe setup really works, instead of only checking that the keys look right.
 * Catches the setup mistakes that otherwise only show up when a customer pays:
 *  - a publishable (pk_) or wrong/rotated secret key  -> checkout fails
 *  - no webhook endpoint for this shop in the key's Stripe account, or missing events
 *    -> payments succeed but orders stay "Abandoned / in checkout"
 * (Stripe does not reveal endpoint signing secrets, so a wrong whsec_ is caught by the
 *  WebhookFailures alarm instead.)
 */

export const REQUIRED_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
] as const;

export type PaymentsProblem = 'stripe_key_rejected' | 'webhook_endpoint_missing' | 'webhook_events_missing';

export interface StripeLike {
  balance: { retrieve(): Promise<unknown> };
  webhookEndpoints: {
    list(params: { limit: number }): Promise<{ data: { url: string; status: string; enabled_events: string[] }[] }>;
  };
}

export interface PaymentsHealth {
  ok: boolean;
  problems: { code: PaymentsProblem; detail: string }[];
}

export async function checkPayments(stripe: StripeLike, webhookUrl: string): Promise<PaymentsHealth> {
  const problems: PaymentsHealth['problems'] = [];

  try {
    await stripe.balance.retrieve();
  } catch (err) {
    problems.push({ code: 'stripe_key_rejected', detail: `Stripe rejected STRIPE_SECRET_KEY: ${(err as Error).message}` });
    return { ok: false, problems }; // the endpoint check needs a working key
  }

  const { data } = await stripe.webhookEndpoints.list({ limit: 100 });
  const endpoint = data.find((e) => e.url === webhookUrl && e.status === 'enabled');
  if (!endpoint) {
    problems.push({
      code: 'webhook_endpoint_missing',
      detail: `No enabled webhook endpoint for ${webhookUrl} in this Stripe account/mode. Paid orders will not be recorded.`,
    });
  } else if (!endpoint.enabled_events.includes('*')) {
    const missing = REQUIRED_WEBHOOK_EVENTS.filter((e) => !endpoint.enabled_events.includes(e));
    if (missing.length) {
      problems.push({ code: 'webhook_events_missing', detail: `Webhook endpoint is missing events: ${missing.join(', ')}` });
    }
  }
  return { ok: problems.length === 0, problems };
}
