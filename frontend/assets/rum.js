// CloudWatch Real User Monitoring: page speed, JavaScript errors and failed requests from real shoppers.
import { getConfig } from './api.js';

getConfig()
  .then(({ rum }) => {
    if (!rum?.appMonitorId) return;
    (function (n, i, v, r, s, c, x, z) {
      x = window.AwsRumClient = { q: [], n, i, v, r, c };
      window[n] = function (c, p) { x.q.push({ c, p }); };
      z = document.createElement('script');
      z.async = true;
      z.src = s;
      document.head.insertBefore(z, document.head.getElementsByTagName('script')[0]);
    })('cwr', rum.appMonitorId, '1.0.0', rum.region, 'https://client.rum.us-east-1.amazonaws.com/1.x/cwr.js', {
      sessionSampleRate: 1,
      identityPoolId: rum.identityPoolId,
      guestRoleArn: rum.guestRoleArn,
      endpoint: `https://dataplane.rum.${rum.region}.amazonaws.com`,
      telemetries: ['performance', 'errors', 'http'],
      allowCookies: true,
      enableXRay: true,
    });
  })
  .catch(() => {});

/** Record a business event in RUM (shows under Events in the RUM console). */
export function track(type, details = {}) {
  try {
    window.cwr?.('recordEvent', { type: `shop.${type}`, data: details });
  } catch {
    /* monitoring must never break the shop */
  }
}
