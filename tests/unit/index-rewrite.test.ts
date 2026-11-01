import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Load the CloudFront Function source exactly as deployed and run its handler.
const source = readFileSync(new URL('../../infra/lib/index-rewrite.js', import.meta.url), 'utf8');
const handler = new Function(`${source}; return handler;`)() as (e: { request: { uri: string } }) => { uri: string };
const rewrite = (uri: string) => handler({ request: { uri } }).uri;

describe('CloudFront index rewrite', () => {
  it('serves index.html for folder URLs', () => {
    expect(rewrite('/')).toBe('/index.html');
    expect(rewrite('/admin/')).toBe('/admin/index.html');
    expect(rewrite('/admin')).toBe('/admin/index.html');
  });

  it('leaves file URLs alone', () => {
    expect(rewrite('/product.html')).toBe('/product.html');
    expect(rewrite('/assets/app.js')).toBe('/assets/app.js');
    expect(rewrite('/config.json')).toBe('/config.json');
  });
});
