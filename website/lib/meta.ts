import type { Metadata } from 'next';
import { SITE_NAME } from './site';

// The shared link-preview image (app/opengraph-image.tsx). Pages that set their own openGraph must list it again.
const OG_IMAGE = { url: '/opengraph-image', width: 1200, height: 630, alt: 'Remastly: your site, rebuilt better' };

/** Title, description, canonical URL and Open Graph for one page. */
export function pageMeta(path: string, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website', siteName: SITE_NAME, locale: 'en', url: path, title: `${title} · ${SITE_NAME}`, description, images: [OG_IMAGE] },
    twitter: { card: 'summary_large_image', title: `${title} · ${SITE_NAME}`, description, images: [OG_IMAGE.url] },
  };
}
