import type { MetadataRoute } from 'next';
import { getPosts } from '@/lib/cms';
import { SITE_URL } from '@/lib/site';

export const revalidate = 300;

const ROUTES = [
  { path: '/', priority: 1 },
  { path: '/features', priority: 0.9 },
  { path: '/how-it-works', priority: 0.9 },
  { path: '/report', priority: 0.8 },
  { path: '/pricing', priority: 0.8 },
  { path: '/media', priority: 0.7 },
  { path: '/faq', priority: 0.6 },
  { path: '/about', priority: 0.6 },
  { path: '/contact', priority: 0.6 },
  { path: '/privacy', priority: 0.3 },
  { path: '/terms', priority: 0.3 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const pages: MetadataRoute.Sitemap = ROUTES.map((r) => ({ url: `${SITE_URL}${r.path === '/' ? '' : r.path}`, lastModified, changeFrequency: 'monthly', priority: r.priority }));
  const posts = (await getPosts())
    .filter((p) => !p.externalUrl)
    .map((p) => ({ url: `${SITE_URL}/media/${p.slug}`, lastModified: new Date(p.updatedAt || p.date), changeFrequency: 'monthly' as const, priority: 0.6 }));
  return [...pages, ...posts];
}
