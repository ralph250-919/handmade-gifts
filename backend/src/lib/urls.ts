/** Turns a site-relative path (e.g. "/images/a.jpg") into an absolute URL. Absolute http(s) URLs are returned unchanged. */
export function absoluteUrl(siteUrl: string, path: string): string {
  return /^https?:\/\//.test(path) ? path : `${siteUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}
