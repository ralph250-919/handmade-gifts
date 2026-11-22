/**
 * Content-Security-Policy for the storefront and admin pages. Scripts may only come from this site
 * (plus the pinned CloudWatch RUM client), so an injected <script> or inline handler won't run and
 * can't read the admin sign-in token. The local dev server sends the same policy, so the browser
 * tests catch anything that breaks it.
 */
export function contentSecurityPolicy(extraConnectSrc: string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self' https://client.rum.us-east-1.amazonaws.com",
    // Inline style attributes are used for layout tweaks; they can't run code.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src ${["'self'", ...extraConnectSrc].join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}
