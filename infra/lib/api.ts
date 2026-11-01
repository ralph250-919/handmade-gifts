import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { AdminAuth } from './auth.js';
import { repoRoot, type ShopSettings } from './shop-stack.js';
import type { Storage } from './storage.js';

export const METRICS_NAMESPACE = 'HandmadeGifts';
export const SERVICE_NAME = 'shop';

/** HTTP API + one Lambda per concern, each with least-privilege access. */
export class Api extends Construct {
  readonly httpApi: apigw.HttpApi;
  readonly functions: Record<string, NodejsFunction> = {};
  readonly accessLogs: logs.LogGroup;

  constructor(
    scope: Construct,
    id: string,
    props: { storage: Storage; auth: AdminAuth; settings: ShopSettings; siteUrl: string },
  ) {
    super(scope, id);
    const { storage, settings } = props;

    const env: Record<string, string> = {
      PRODUCTS_TABLE: storage.productsTable.tableName,
      ORDERS_TABLE: storage.ordersTable.tableName,
      STRIPE_SECRET_ARN: storage.stripeSecret.secretArn,
      IMAGES_BUCKET: storage.imagesBucket.bucketName,
      SITE_URL: props.siteUrl,
      SHOP_NAME: settings.shopName,
      CURRENCY: settings.currency,
      ALLOWED_COUNTRIES: settings.allowedShippingCountries.join(','),
      SHIPPING_STANDARD_CENTS: String(settings.shippingStandardCents),
      FREE_SHIPPING_OVER_CENTS: String(settings.freeShippingOverCents),
      SENDER_EMAIL: settings.senderEmail ?? '',
      OWNER_EMAIL: settings.alertEmail ?? settings.adminEmail ?? '',
      POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
      POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
      POWERTOOLS_LOG_LEVEL: 'INFO',
      NODE_OPTIONS: '--enable-source-maps',
    };

    const fn = (name: string, file: string, opts: { timeout?: number } = {}) => {
      const f = new NodejsFunction(this, name, {
        entry: path.join(repoRoot, 'backend/src/handlers', file),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(opts.timeout ?? 15),
        tracing: lambda.Tracing.ACTIVE,
        environment: env,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        bundling: { minify: true, sourceMap: true, target: 'node22' },
        projectRoot: repoRoot,
        depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      });
      this.functions[name] = f;
      return f;
    };

    const products = fn('Products', 'products.ts');
    const checkout = fn('Checkout', 'checkout.ts');
    const webhook = fn('StripeWebhook', 'stripeWebhook.ts', { timeout: 30 });
    const adminProducts = fn('AdminProducts', 'adminProducts.ts');
    const orders = fn('AdminOrders', 'orders.ts');
    const uploads = fn('AdminUploads', 'uploads.ts');
    const feed = fn('CatalogFeed', 'feed.ts');
    const health = fn('Health', 'health.ts');

    // Least-privilege permissions
    storage.productsTable.grantReadData(products);
    storage.productsTable.grantReadData(feed);
    storage.productsTable.grantReadData(health);
    storage.productsTable.grantReadData(checkout);
    storage.ordersTable.grantWriteData(checkout);
    storage.productsTable.grantReadWriteData(webhook);
    storage.ordersTable.grantReadWriteData(webhook);
    storage.productsTable.grantReadWriteData(adminProducts);
    storage.ordersTable.grantReadWriteData(orders);
    storage.imagesBucket.grantPut(uploads);
    for (const f of [checkout, webhook, health]) storage.stripeSecret.grantRead(f);
    const sendEmail = new iam.PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] });
    webhook.addToRolePolicy(sendEmail);
    orders.addToRolePolicy(sendEmail);

    this.accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Same-origin via CloudFront, so no CORS needed except for the local dev server.
    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      description: `${settings.shopName} API`,
      corsPreflight: {
        allowOrigins: ['http://localhost:5173'],
        allowMethods: [apigw.CorsHttpMethod.ANY],
        allowHeaders: ['content-type', 'authorization'],
      },
    });

    const stage = this.httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100, detailedMetricsEnabled: true };
    stage.accessLogSettings = {
      destinationArn: this.accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        method: '$context.httpMethod',
        route: '$context.routeKey',
        status: '$context.status',
        latencyMs: '$context.responseLatency',
        integrationError: '$context.integrationErrorMessage',
        userAgent: '$context.identity.userAgent',
      }),
    };

    const authorizer = new HttpUserPoolAuthorizer('AdminAuthorizer', props.auth.userPool, {
      userPoolClients: [props.auth.client],
    });

    const route = (p: string, methods: apigw.HttpMethod[], f: NodejsFunction, admin = false) =>
      this.httpApi.addRoutes({
        path: p,
        methods,
        integration: new HttpLambdaIntegration(`${f.node.id}${methods.join('')}${p.replace(/\W/g, '')}`, f),
        authorizer: admin ? authorizer : undefined,
      });

    const { GET, POST, PUT, DELETE } = apigw.HttpMethod;
    route('/api/health', [GET], health);
    route('/api/products', [GET], products);
    route('/api/products/{slug}', [GET], products);
    route('/api/checkout', [POST], checkout);
    route('/api/webhooks/stripe', [POST], webhook);
    route('/api/feed/catalog.csv', [GET], feed);
    route('/api/admin/products', [GET, POST], adminProducts, true);
    route('/api/admin/products/{id}', [PUT, DELETE], adminProducts, true);
    route('/api/admin/orders', [GET], orders, true);
    route('/api/admin/orders/{id}/ship', [POST], orders, true);
    route('/api/admin/uploads', [POST], uploads, true);
  }
}
