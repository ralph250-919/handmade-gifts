import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

/**
 * Structured JSON logs, CloudWatch custom metrics (EMF) and X-Ray tracing.
 * Service name and metrics namespace come from POWERTOOLS_* env vars set in CDK.
 */
export const logger = new Logger();
export const metrics = new Metrics();
export const tracer = new Tracer();

/** Business metric names. Alarms and the dashboard in infra/lib/monitoring.ts refer to these. */
export const Metric = {
  CheckoutStarted: 'CheckoutStarted',
  CheckoutRejected: 'CheckoutRejected',
  CheckoutFailed: 'CheckoutFailed',
  CheckoutCompleted: 'CheckoutCompleted',
  CheckoutExpired: 'CheckoutExpired',
  OrderRevenueCents: 'OrderRevenueCents',
  WebhookFailed: 'WebhookFailed',
  OrderEmailFailed: 'OrderEmailFailed',
  StockConflict: 'StockConflict',
} as const;
export type MetricName = (typeof Metric)[keyof typeof Metric];

export function countMetric(name: MetricName, value = 1): void {
  metrics.addMetric(name, MetricUnit.Count, value);
}

export { MetricUnit };
