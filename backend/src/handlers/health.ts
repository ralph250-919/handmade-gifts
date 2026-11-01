import * as db from '../lib/db.js';
import { httpHandler, json } from '../lib/http.js';
import { logger } from '../lib/observability.js';
import { getStripeSecrets, isConfigured } from '../lib/stripe.js';

/** GET /api/health — used by the Synthetics canary. 503 means customers can't buy right now. */
export const handler = httpHandler(async () => {
  const checks: Record<string, boolean> = { database: false, payments: false };
  await db.ping().then(() => (checks.database = true)).catch((e) => logger.error('DB health check failed', e));
  await getStripeSecrets()
    .then((s) => (checks.payments = isConfigured(s)))
    .catch((e) => logger.error('Stripe secret check failed', e));
  const ok = Object.values(checks).every(Boolean);
  return json(ok ? 200 : 503, { ok, checks });
});
