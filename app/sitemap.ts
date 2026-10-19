import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

const ROUTES = [
  { path: '/', priority: 1 },
  { path: '/features', priority: 0.9 },
  { path: '/how-it-works', priority: 0.9 },
  { path: '/report', priority: 0.8 },
  { path: '/pricing', priority: 0.8 },
  { path: '/faq', priority: 0.6 },
  { path: '/about', priority: 0.6 },
  { path: '/contact', priority: 0.6 },
  { path: '/privacy', priority: 0.3 },
  { path: '/terms', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map((r) => ({ url: `${SITE_URL}${r.path === '/' ? '' : r.path}`, lastModified, changeFrequency: 'monthly', priority: r.priority }));
}
