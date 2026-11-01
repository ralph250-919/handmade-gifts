import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { UserFacingError } from './errors.js';
import { logger, metrics } from './observability.js';

export type HttpEvent = APIGatewayProxyEventV2;
export type HttpResult = APIGatewayProxyStructuredResultV2;

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  };
}

/** Returns the raw request body as a string (HTTP API may base64-encode it). */
export function rawBody(event: HttpEvent): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

export function parseJsonBody(event: HttpEvent): unknown {
  try {
    return JSON.parse(rawBody(event) || '{}');
  } catch {
    throw new UserFacingError(400, 'Request body must be valid JSON', 'INVALID_JSON');
  }
}

/**
 * Wraps a Lambda HTTP handler with: request-scoped log context, consistent error
 * responses (a request id the customer can quote to you), and metric flushing.
 */
export function httpHandler(
  fn: (event: HttpEvent, context: Context) => Promise<HttpResult>,
): (event: HttpEvent, context: Context) => Promise<HttpResult> {
  return async (event, context) => {
    logger.addContext(context);
    logger.appendKeys({ route: event.routeKey, requestId: event.requestContext?.requestId });
    try {
      return await fn(event, context);
    } catch (err) {
      if (err instanceof UserFacingError) {
        logger.warn('Request rejected', { code: err.code, message: err.message, statusCode: err.statusCode });
        return json(err.statusCode, { error: err.message, code: err.code });
      }
      logger.error('Unhandled error', err as Error);
      return json(500, {
        error: 'Something went wrong on our side. Please try again in a moment.',
        code: 'INTERNAL',
        requestId: event.requestContext?.requestId,
      });
    } finally {
      metrics.publishStoredMetrics();
      logger.resetKeys();
    }
  };
}

/** Email of the signed-in admin (from the Cognito JWT validated by API Gateway). */
export function adminEmail(event: HttpEvent): string | undefined {
  const ctx = event.requestContext as unknown as { authorizer?: { jwt?: { claims?: Record<string, string> } } };
  return ctx.authorizer?.jwt?.claims?.email;
}
