import type { MetadataRoute } from 'next';
import { SITE_URL } from './layout';

/**
 * AI crawlers are deliberately allowed. This is a developer tool whose audience
 * asks assistants for recommendations, so blocking them costs reach and buys
 * nothing: everything under /dashboard is behind auth and row-level security,
 * not behind robots.txt.
 *
 * The signed-in area and the OAuth callback are disallowed because they are
 * per-user and have nothing to index, not because they are secret.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/dashboard', '/auth/'] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
