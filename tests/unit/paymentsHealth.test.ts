import { describe, expect, it, vi } from 'vitest';
import { checkPayments, REQUIRED_WEBHOOK_EVENTS, type StripeLike } from '../../backend/src/lib/paymentsHealth.js';

const URL = 'https://shop.example/api/webhooks/stripe';

function stripe(o: { balanceError?: Error; endpoints?: { url: string; status: string; enabled_events: string[] }[] } = {}): StripeLike {
  return {
    balance: { retrieve: vi.fn(async () => { if (o.balanceError) throw o.balanceError; return {}; }) },
    webhookEndpoints: { list: vi.fn(async () => ({ data: o.endpoints ?? [] })) },
  };
}
const good = { url: URL, status: 'enabled', enabled_events: [...REQUIRED_WEBHOOK_EVENTS] };

describe('checkPayments', () => {
  it('passes with a working key and a matching endpoint', async () => {
    expect(await checkPayments(stripe({ endpoints: [good] }), URL)).toEqual({ ok: true, problems: [] });
  });

  it('accepts an endpoint subscribed to all events', async () => {
    expect((await checkPayments(stripe({ endpoints: [{ ...good, enabled_events: ['*'] }] }), URL)).ok).toBe(true);
  });

  it('flags a rejected key (e.g. a publishable pk_ key) and skips the endpoint check', async () => {
    const s = stripe({ balanceError: new Error('This API call cannot be made with a publishable API key.') });
    const r = await checkPayments(s, URL);
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.code).toBe('stripe_key_rejected');
    expect(s.webhookEndpoints.list).not.toHaveBeenCalled();
  });

  it('flags a missing endpoint (none, wrong URL, or disabled)', async () => {
    for (const endpoints of [[], [{ ...good, url: 'https://other.example/hook' }], [{ ...good, status: 'disabled' }]]) {
      const r = await checkPayments(stripe({ endpoints }), URL);
      expect(r.problems.map((p) => p.code)).toEqual(['webhook_endpoint_missing']);
    }
  });

  it('flags missing events and names them', async () => {
    const r = await checkPayments(stripe({ endpoints: [{ ...good, enabled_events: ['checkout.session.completed'] }] }), URL);
    expect(r.problems[0]?.code).toBe('webhook_events_missing');
    expect(r.problems[0]?.detail).toContain('checkout.session.expired');
  });
});
