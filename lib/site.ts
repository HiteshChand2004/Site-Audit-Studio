// Site-wide settings. Set SITE_URL (e.g. https://remastly.com) when deploying so canonical URLs, the sitemap and
// Open Graph images point at the real domain.
export const SITE_URL = (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const SITE_NAME = 'Remastly';
/** The public contact address, from NEXT_PUBLIC_CONTACT_EMAIL. null until a real one is set: nothing on the site shows an address or a mailto: link while it is null. */
export const CONTACT_EMAIL: string | null = process.env.NEXT_PUBLIC_CONTACT_EMAIL || null;
export const TAGLINE = 'Not a lookalike. The original, measured.';
export const DESCRIPTION =
  'Remastly keeps your page’s own markup, styles and animations, measures the copy against the original, then fixes what the audit finds. Output in HTML, React + Vite, Next.js or MERN.';

/** The Remastly app. Sign-in and sign-up forms post here; when it is not set, the forms say sign-in is not open and send nothing. */
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
