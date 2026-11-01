#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ShopStack, type ShopSettings } from './lib/shop-stack.js';

const app = new cdk.App();
const ctx = (key: string) => app.node.tryGetContext(key);

const settings: ShopSettings = {
  shopName: ctx('shopName') ?? 'Handmade Gifts',
  currency: (ctx('currency') ?? 'usd').toLowerCase(),
  allowedShippingCountries: ctx('allowedShippingCountries') ?? ['US'],
  shippingStandardCents: Number(ctx('shippingStandardCents') ?? 600),
  freeShippingOverCents: Number(ctx('freeShippingOverCents') ?? 0),
  adminEmail: ctx('adminEmail') || undefined,
  alertEmail: ctx('alertEmail') || undefined,
  senderEmail: ctx('senderEmail') || undefined,
  monthlyBudgetUsd: Number(ctx('monthlyBudgetUsd') ?? 20),
  cognitoDomainPrefix: ctx('cognitoDomainPrefix') || undefined,
};

new ShopStack(app, ctx('stackName') ?? 'HandmadeGiftsShop', {
  settings,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: `${settings.shopName} online shop (storefront, checkout, admin, monitoring)`,
});
