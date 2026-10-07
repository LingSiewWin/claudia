import type { MetadataRoute } from 'next';
import { PUBLIC_SITE_URL, config } from '../lib/config';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ['/', '/protocol', '/live', '/console', `/mandate/${config.stageMandateId}`, '/authority/CFO', '/receipt/R-0002', '/terms', '/privacy'];
  return paths.map((path) => ({ url: new URL(path, PUBLIC_SITE_URL).toString() }));
}
