import { z } from 'zod';
import { env } from '../lib/config.js';
import * as db from '../lib/db.js';
import { emailEnabled, sendEmail, shippedEmail } from '../lib/email.js';
import { UserFacingError } from '../lib/errors.js';
import { adminEmail, httpHandler, json, parseJsonBody } from '../lib/http.js';
import { countMetric, logger, Metric } from '../lib/observability.js';
import { Transitions } from '../lib/orders.js';
import type { OrderStatus } from '../lib/types.js';

const statuses = ['PENDING', 'PAID', 'SHIPPED', 'EXPIRED', 'CANCELLED'] as const;
const shipInput = z.object({ trackingNumber: z.string().trim().max(100).optional(), carrier: z.string().trim().max(40).optional() });

/**
 * Admin order management (Cognito-protected):
 *   GET  /api/admin/orders?status=PAID
 *   POST /api/admin/orders/{id}/ship   { trackingNumber?, carrier? }
 */
export const handler = httpHandler(async (event) => {
  const id = event.pathParameters?.id;
  if (event.requestContext.http.method === 'GET') {
    const status = (event.queryStringParameters?.status ?? 'PAID').toUpperCase() as OrderStatus;
    if (!statuses.includes(status)) throw new UserFacingError(400, 'Unknown status');
    return json(200, await db.listOrders(status));
  }

  if (!id) throw new UserFacingError(400, 'Missing order id');
  const parsed = shipInput.safeParse(parseJsonBody(event));
  if (!parsed.success) throw new UserFacingError(400, 'Invalid tracking details');

  const order = await db.transitionOrder(id, Transitions.ship.from, Transitions.ship.to, { ...parsed.data, shippedAt: new Date().toISOString() });
  if (!order) throw new UserFacingError(409, 'Only paid orders can be marked as shipped', 'INVALID_STATE');
  logger.info('Order shipped', { orderId: id, by: adminEmail(event) });

  if (!emailEnabled()) return json(200, { order, emailed: false, emailDisabled: true });
  if (!order.customerEmail) return json(200, { order, emailed: false, noCustomerEmail: true });
  try {
    await sendEmail(shippedEmail(order, env('SHOP_NAME')));
    return json(200, { order, emailed: true });
  } catch (err) {
    countMetric(Metric.OrderEmailFailed);
    logger.error('Failed to send shipping email', err as Error);
    return json(200, { order, emailed: false });
  }
});
