import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rum from 'aws-cdk-lib/aws-rum';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import { Construct } from 'constructs';
import { METRICS_NAMESPACE, SERVICE_NAME, type Api } from './api.js';

/**
 * Customer-experience monitoring:
 *  - CloudWatch RUM: real page-load times and JavaScript errors from shoppers' browsers
 *  - Synthetics canary: a robot "customer" visits the shop every 5 minutes
 *  - Business metrics + alarms: failed checkouts, webhook failures, email failures, oversells
 *  - Technical alarms: Lambda errors, API 5xx, slow responses
 *  - Dashboard, saved Logs Insights queries and a monthly budget alert
 */
export class Monitoring extends Construct {
  readonly dashboard: cw.Dashboard;
  readonly alarmTopic: sns.Topic;
  readonly rumConfig: Record<string, unknown>;

  constructor(
    scope: Construct,
    id: string,
    props: { api: Api; siteUrl: string; siteDomain: string; alertEmail?: string; monthlyBudgetUsd: number },
  ) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const { api } = props;

    // ---------- Alerts go to your email ----------
    this.alarmTopic = new sns.Topic(this, 'Alerts', { displayName: 'Shop alerts' });
    if (props.alertEmail) this.alarmTopic.addSubscription(new subs.EmailSubscription(props.alertEmail));
    const alarmAction = new actions.SnsAction(this.alarmTopic);
    const allAlarms: cw.Alarm[] = [];

    const alarm = (idName: string, metric: cw.IMetric, o: { threshold: number; periods?: number; description: string; comparison?: cw.ComparisonOperator }) => {
      const a = new cw.Alarm(this, idName, {
        alarmName: `${stack.stackName}-${idName}`,
        alarmDescription: o.description,
        metric,
        threshold: o.threshold,
        evaluationPeriods: o.periods ?? 1,
        comparisonOperator: o.comparison ?? cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(alarmAction);
      a.addOkAction(alarmAction);
      allAlarms.push(a);
      return a;
    };

    const biz = (metricName: string, period = cdk.Duration.minutes(5)) =>
      new cw.Metric({ namespace: METRICS_NAMESPACE, metricName, dimensionsMap: { service: SERVICE_NAME }, statistic: 'Sum', period });

    // ---------- Real User Monitoring ----------
    const identityPool = new cognito.CfnIdentityPool(this, 'RumIdentityPool', { allowUnauthenticatedIdentities: true });
    const appMonitorName = `${stack.stackName}-storefront`;
    const guestRole = new iam.Role(this, 'RumGuestRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'unauthenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });
    guestRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['rum:PutRumEvents'],
        resources: [stack.formatArn({ service: 'rum', resource: 'appmonitor', resourceName: appMonitorName })],
      }),
    );
    new cognito.CfnIdentityPoolRoleAttachment(this, 'RumRoles', {
      identityPoolId: identityPool.ref,
      roles: { unauthenticated: guestRole.roleArn },
    });
    const appMonitor = new rum.CfnAppMonitor(this, 'Rum', {
      name: appMonitorName,
      domain: props.siteDomain,
      cwLogEnabled: true,
      appMonitorConfiguration: {
        allowCookies: true,
        enableXRay: true,
        sessionSampleRate: 1,
        telemetries: ['errors', 'performance', 'http'],
        identityPoolId: identityPool.ref,
        guestRoleArn: guestRole.roleArn,
      },
    });
    this.rumConfig = {
      appMonitorId: appMonitor.attrId,
      identityPoolId: identityPool.ref,
      guestRoleArn: guestRole.roleArn,
      region: stack.region,
    };
    const rumMetric = (metricName: string, statistic: string) =>
      new cw.Metric({ namespace: 'AWS/RUM', metricName, dimensionsMap: { application_name: appMonitorName }, statistic, period: cdk.Duration.minutes(5) });

    // ---------- Synthetic customer ----------
    const canary = new synthetics.Canary(this, 'Canary', {
      canaryName: `${stack.stackName}`.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 21),
      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_9_1,
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(5)),
      environmentVariables: { SITE_URL: props.siteUrl },
      provisionedResourceCleanup: true,
      test: synthetics.Test.custom({
        handler: 'index.handler',
        code: synthetics.Code.fromInline(CANARY_SCRIPT),
      }),
    });

    // ---------- Alarms: is the shop working for customers? ----------
    alarm('CanaryFailing', canary.metricSuccessPercent({ period: cdk.Duration.minutes(5), statistic: 'Average' }), {
      threshold: 100,
      periods: 2,
      comparison: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      description: 'The robot shopper could not load the shop or its products for 10 minutes. Customers are probably affected. See README > Runbook > CanaryFailing.',
    });
    alarm('CheckoutFailures', biz('CheckoutFailed', cdk.Duration.minutes(15)), {
      threshold: 3,
      description: 'Customers could not start checkout (Stripe error or misconfiguration). See README > Runbook > CheckoutFailures.',
    });
    alarm('WebhookFailures', biz('WebhookFailed'), {
      threshold: 1,
      description: 'Stripe payment notifications are failing, so paid orders may not be recorded. See README > Runbook > WebhookFailures.',
    });
    alarm('OrderEmailFailures', biz('OrderEmailFailed'), {
      threshold: 1,
      description: 'An order or shipping email could not be sent. Check the order in admin and contact the customer. See README > Runbook.',
    });
    alarm('StockConflict', biz('StockConflict'), {
      threshold: 1,
      description: 'An item sold more times than it was in stock. The order is flagged in admin; contact the customer.',
    });
    alarm('Api5xx', api.httpApi.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }), {
      threshold: 5,
      description: 'The API returned 5 or more server errors in 5 minutes.',
    });
    alarm('ApiSlow', api.httpApi.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p95' }), {
      threshold: 2000,
      periods: 3,
      description: '95% of API responses took longer than 2 seconds for 15 minutes.',
    });
    alarm('BrowserErrors', rumMetric('JsErrorCount', 'Sum'), {
      threshold: 10,
      description: 'Shoppers hit 10+ JavaScript errors in 5 minutes. Check CloudWatch RUM > Errors.',
    });
    for (const [name, f] of Object.entries(api.functions)) {
      const critical = name === 'Checkout' || name === 'StripeWebhook';
      alarm(`${name}Errors`, f.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }), {
        threshold: critical ? 1 : 5,
        description: `Lambda function ${name} is throwing errors. Check its logs (Logs Insights query "Shop errors").`,
      });
    }

    // ---------- Saved Logs Insights queries ----------
    const logGroupNames = [...Object.values(api.functions).map((f) => f.logGroup.logGroupName)];
    new logs.CfnQueryDefinition(this, 'ErrorsQuery', {
      name: `${stack.stackName}/Shop errors`,
      logGroupNames,
      queryString: 'fields @timestamp, level, message, route, requestId, orderId, error.message\n| filter level in ["ERROR", "WARN"]\n| sort @timestamp desc\n| limit 200',
    });
    new logs.CfnQueryDefinition(this, 'OrderTraceQuery', {
      name: `${stack.stackName}/Find an order (edit the id)`,
      logGroupNames,
      queryString: 'fields @timestamp, level, message, route, stripeEventType\n| filter orderId = "cs_test_REPLACE"\n| sort @timestamp asc',
    });
    new logs.CfnQueryDefinition(this, 'SlowRequestsQuery', {
      name: `${stack.stackName}/Slow or failed API requests`,
      logGroupNames: [api.accessLogs.logGroupName],
      queryString: 'fields @timestamp, route, status, latencyMs, integrationError\n| filter latencyMs > 1500 or status >= 500\n| sort @timestamp desc\n| limit 200',
    });

    // ---------- Dashboard ----------
    this.dashboard = new cw.Dashboard(this, 'Dashboard', {
      dashboardName: `${stack.stackName}-customer-experience`,
      defaultInterval: cdk.Duration.days(1),
    });
    const hourly = (m: string) => biz(m, cdk.Duration.hours(1));
    this.dashboard.addWidgets(
      new cw.TextWidget({
        markdown: `# ${stack.stackName} — customer experience\nShop: ${props.siteUrl} · Red alarms below need attention. Runbook: see README.`,
        width: 24,
        height: 2,
      }),
    );
    this.dashboard.addWidgets(
      new cw.AlarmStatusWidget({ title: 'Alarms', alarms: allAlarms, width: 24, height: 4 }),
    );
    this.dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'Checkout funnel (per hour)',
        left: [hourly('CheckoutStarted'), hourly('CheckoutCompleted'), hourly('CheckoutExpired'), hourly('CheckoutRejected'), hourly('CheckoutFailed')],
        width: 12,
      }),
      new cw.SingleValueWidget({
        title: 'Orders & revenue (cents) — last 24h',
        metrics: [biz('CheckoutCompleted', cdk.Duration.days(1)), biz('OrderRevenueCents', cdk.Duration.days(1))],
        width: 12,
      }),
    );
    this.dashboard.addWidgets(
      new cw.GraphWidget({ title: 'Robot shopper success %', left: [canary.metricSuccessPercent()], leftYAxis: { min: 0, max: 100 }, width: 8 }),
      new cw.GraphWidget({
        title: 'Real shoppers: page load (ms) & JS errors',
        left: [rumMetric('PerformanceNavigationDuration', 'p90')],
        right: [rumMetric('JsErrorCount', 'Sum')],
        width: 8,
      }),
      new cw.GraphWidget({
        title: 'API: requests, 4xx, 5xx',
        left: [api.httpApi.metricCount(), api.httpApi.metricClientError(), api.httpApi.metricServerError()],
        width: 8,
      }),
    );
    this.dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'API latency (ms)',
        left: [api.httpApi.metricLatency({ statistic: 'p50' }), api.httpApi.metricLatency({ statistic: 'p95' })],
        width: 12,
      }),
      new cw.GraphWidget({
        title: 'Lambda errors by function',
        left: Object.entries(api.functions).map(([n, f]) => f.metricErrors({ label: n, statistic: 'Sum' })),
        width: 12,
      }),
    );
    this.dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'Problems needing follow-up',
        left: [hourly('WebhookFailed'), hourly('OrderEmailFailed'), hourly('StockConflict')],
        width: 12,
      }),
      new cw.LogQueryWidget({
        title: 'Latest errors & warnings',
        logGroupNames,
        queryLines: ['fields @timestamp, level, message, route, orderId', 'filter level in ["ERROR", "WARN"]', 'sort @timestamp desc', 'limit 20'],
        width: 12,
      }),
    );

    // ---------- Cost guardrail ----------
    if (props.alertEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.monthlyBudgetUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          {
            notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 },
            subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
          },
          {
            notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 },
            subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
          },
        ],
      });
    }
  }
}

/** Synthetics canary: loads the home page in a real browser and checks the API is healthy. */
const CANARY_SCRIPT = `
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

exports.handler = async function () {
  const site = process.env.SITE_URL;

  await synthetics.executeStep('api-health', async function () {
    const res = await fetch(site + '/api/health');
    const body = await res.text();
    if (res.status !== 200) throw new Error('Health check failed: ' + res.status + ' ' + body);
  });

  let firstSlug;
  await synthetics.executeStep('api-products', async function () {
    const res = await fetch(site + '/api/products');
    if (res.status !== 200) throw new Error('Products API returned ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data.products)) throw new Error('Products API returned unexpected data');
    firstSlug = data.products[0] && data.products[0].slug;
    log.info('Products listed: ' + data.products.length);
  });

  const page = await synthetics.getPage();
  await synthetics.executeStep('home-page', async function () {
    const res = await page.goto(site + '/', { waitUntil: 'networkidle0', timeout: 30000 });
    if (!res || res.status() >= 400) throw new Error('Home page returned ' + (res && res.status()));
    await page.waitForSelector('[data-testid="product-grid"]', { timeout: 15000 });
  });

  if (firstSlug) {
    await synthetics.executeStep('product-page', async function () {
      await page.goto(site + '/product.html?slug=' + encodeURIComponent(firstSlug), { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('[data-testid="add-to-cart"]', { timeout: 15000 });
    });
  }
};
`;
