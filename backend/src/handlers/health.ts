import { env } from '../lib/config.js';
import * as db from '../lib/db.js';
import { httpHandler, json } from '../lib/http.js';
import { logger } from '../lib/observability.js';
import { checkPayments, type PaymentsHealth } from '../lib/paymentsHealth.js';
import { getStripe, getStripeSecrets, isConfigured } from '../lib/stripe.js';

// The canary calls this every 5 minutes; cache the Stripe check so we stay well inside Stripe's rate limits.
const CACHE_MS = 5 * 60 * 1000;
let cachedPayments: { at: number; key: string; result: PaymentsHealth } | undefined;

async function paymentsHealth(): Promise<PaymentsHealth> {
  const secrets = await getStripeSecrets();
  if (!isConfigured(secrets)) {
    return { ok: false, problems: [{ code: 'stripe_key_rejected', detail: 'Stripe keys are not set (still REPLACE_ME or wrong format)' }] };
  }
  const cacheKey = `${secrets.STRIPE_SECRET_KEY.slice(-6)}:${secrets.STRIPE_WEBHOOK_SECRET.slice(-6)}`;
  if (cachedPayments && cachedPayments.key === cacheKey && Date.now() - cachedPayments.at < CACHE_MS) return cachedPayments.result;
  const result = await checkPayments(await getStripe(), `${env('SITE_URL')}/api/webhooks/stripe`);
  cachedPayments = { at: Date.now(), key: cacheKey, result };
  return result;
}

/** GET /api/health — used by the Synthetics canary. 503 means customers can't buy right now. */
export const handler = httpHandler(async () => {
  const checks: Record<string, boolean> = { database: false, payments: false };
  const problems: string[] = [];

  await db.ping().then(() => (checks.database = true)).catch((e) => logger.error('DB health check failed', e));

  try {
    const p = await paymentsHealth();
    checks.payments = p.ok;
    for (const problem of p.problems) {
      problems.push(problem.code);
      logger.error('Payments health check failed', { code: problem.code, detail: problem.detail });
    }
  } catch (e) {
    problems.push('stripe_unreachable');
    logger.error('Payments health check errored', e as Error);
  }

  const ok = Object.values(checks).every(Boolean);
  // Only short codes are public; details are in the Health function's logs.
  return json(ok ? 200 : 503, { ok, checks, problems });
});
