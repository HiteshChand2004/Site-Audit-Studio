// Site-wide settings. Set SITE_URL (e.g. https://remastly.com) when deploying so canonical URLs, the sitemap and
// Open Graph images point at the real domain.
export const SITE_URL = (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const SITE_NAME = 'Remastly';
export const CONTACT_EMAIL = '[YOUR EMAIL]';
export const TAGLINE = 'Paste a link. Get a better site.';
export const DESCRIPTION =
  'Remastly audits your website, fixes what it finds and rebuilds it as a clean copy that looks the same, in HTML, React + Vite, Next.js or MERN.';

/** The Remastly app. Sign-in and sign-up forms post here; when it is not set, the forms say sign-in opens soon. */
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');

export const NAV = [
  { href: '/features', label: 'Features' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/faq', label: 'FAQ' },
  { href: '/about', label: 'About' },
];

export const FOOTER_NAV = [
  {
    title: 'Product',
    links: [
      { href: '/features', label: 'Features' },
      { href: '/how-it-works', label: 'How it works' },
      { href: '/report', label: 'Audit report' },
      { href: '/pricing', label: 'Pricing' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/about', label: 'About' },
      { href: '/faq', label: 'FAQ' },
      { href: '/contact', label: 'Contact' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/privacy', label: 'Privacy' },
      { href: '/terms', label: 'Terms' },
    ],
  },
];
