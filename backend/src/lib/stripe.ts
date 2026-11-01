import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import Stripe from 'stripe';
import { env } from './config.js';
import { tracer } from './observability.js';

interface StripeSecrets {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

const secrets = tracer.captureAWSv3Client(new SecretsManagerClient({}));
let cached: { value: StripeSecrets; at: number } | undefined;
const CACHE_MS = 5 * 60 * 1000;

/** Loads Stripe keys from Secrets Manager (cached for 5 minutes so key rotation is picked up). */
export async function getStripeSecrets(): Promise<StripeSecrets> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: env('STRIPE_SECRET_ARN') }));
  const value = JSON.parse(res.SecretString ?? '{}') as StripeSecrets;
  cached = { value, at: Date.now() };
  return value;
}

export function isConfigured(s: StripeSecrets): boolean {
  return /^(sk|rk)_(test|live)_/.test(s.STRIPE_SECRET_KEY ?? '') && (s.STRIPE_WEBHOOK_SECRET ?? '').startsWith('whsec_');
}

let client: { key: string; stripe: Stripe } | undefined;

export async function getStripe(): Promise<Stripe> {
  const { STRIPE_SECRET_KEY } = await getStripeSecrets();
  if (!client || client.key !== STRIPE_SECRET_KEY) {
    client = {
      key: STRIPE_SECRET_KEY,
      stripe: new Stripe(STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 10_000, appInfo: { name: 'handmade-gifts' } }),
    };
  }
  return client.stripe;
}
