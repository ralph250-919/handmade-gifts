#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ShopStack, type ShopSettings } from './lib/shop-stack.js';

const app = new cdk.App();
const ctx = (key: string) => app.node.tryGetContext(key);

/** Prices are entered and stored as cents everywhere, so only currencies with exactly 2 decimals work. */
function twoDecimalCurrency(code: string): string {
  const digits = new Intl.NumberFormat('en-US', { style: 'currency', currency: code.toUpperCase() }).resolvedOptions().maximumFractionDigits;
  if (digits !== 2) throw new Error(`currency "${code}" has ${digits} decimal places; this shop only supports currencies with 2 (e.g. usd, eur, gbp).`);
  return code.toLowerCase();
}

/** Reads a whole-number context value, failing the deploy on typos instead of passing "NaN" to Lambda. */
function intContext(key: string, fallback: number): number {
  const raw = ctx(key) ?? fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a whole number of cents, got "${raw}"`);
  return n;
}

const settings: ShopSettings = {
  shopName: ctx('shopName') ?? 'Handmade Gifts',
  currency: twoDecimalCurrency(ctx('currency') ?? 'usd'),
  allowedShippingCountries: ctx('allowedShippingCountries') ?? ['US'],
  shippingStandardCents: intContext('shippingStandardCents', 600),
  freeShippingOverCents: intContext('freeShippingOverCents', 0),
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
