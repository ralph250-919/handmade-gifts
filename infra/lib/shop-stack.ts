import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Storage } from './storage.js';
import { Api } from './api.js';
import { Frontend } from './frontend.js';
import { AdminAuth } from './auth.js';
import { Monitoring } from './monitoring.js';

export interface ShopSettings {
  shopName: string;
  currency: string;
  allowedShippingCountries: string[];
  shippingStandardCents: number;
  freeShippingOverCents: number;
  adminEmail?: string;
  alertEmail?: string;
  senderEmail?: string;
  monthlyBudgetUsd: number;
  cognitoDomainPrefix?: string;
}

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export class ShopStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { settings: ShopSettings }) {
    super(scope, id, props);
    const { settings } = props;

    const storage = new Storage(this, 'Storage', { senderEmail: settings.senderEmail });
    const frontend = new Frontend(this, 'Frontend', { siteBucket: storage.siteBucket, imagesBucket: storage.imagesBucket });
    const siteUrl = `https://${frontend.distribution.distributionDomainName}`;

    const auth = new AdminAuth(this, 'AdminAuth', {
      siteUrl,
      adminEmail: settings.adminEmail,
      domainPrefix: settings.cognitoDomainPrefix,
    });

    const api = new Api(this, 'Api', { storage, auth, settings, siteUrl });
    frontend.addApiOrigin(api.httpApi);

    const monitoring = new Monitoring(this, 'Monitoring', {
      api,
      siteUrl,
      siteDomain: frontend.distribution.distributionDomainName,
      alertEmail: settings.alertEmail,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
    });

    frontend.deploySite({
      apiBase: '',
      shopName: settings.shopName,
      currency: settings.currency,
      freeShippingOverCents: settings.freeShippingOverCents,
      shippingStandardCents: settings.shippingStandardCents,
      cognito: { domain: auth.domainUrl, clientId: auth.client.userPoolClientId },
      rum: monitoring.rumConfig,
    });

    new cdk.CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new cdk.CfnOutput(this, 'AdminUrl', { value: `${siteUrl}/admin/` });
    new cdk.CfnOutput(this, 'StripeWebhookUrl', { value: `${siteUrl}/api/webhooks/stripe`, description: 'Add this endpoint in Stripe Dashboard > Developers > Webhooks' });
    new cdk.CfnOutput(this, 'StripeSecretName', { value: storage.stripeSecret.secretName });
    new cdk.CfnOutput(this, 'CatalogFeedUrl', { value: `${siteUrl}/api/feed/catalog.csv`, description: 'Meta Commerce / Instagram Shopping data feed' });
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${monitoring.dashboard.dashboardName}`,
    });
    new cdk.CfnOutput(this, 'ProductsTable', { value: storage.productsTable.tableName });
  }
}
