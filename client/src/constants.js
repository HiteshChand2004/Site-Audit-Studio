export const STACKS = [
  {
    id: 'html',
    name: 'Plain HTML / CSS / JS',
    short: 'HTML',
    detail: 'Static, zero-dependency output. Fastest load, kahin bhi host ho jaata hai.',
  },
  {
    id: 'react-vite',
    name: 'React + Vite',
    short: 'React',
    detail: 'Component-based SPA with production build. Pre-rendered HTML for SEO.',
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    short: 'Next',
    detail: 'Static export / SSR, file-based routing, built-in image optimisation.',
  },
  {
    id: 'mern',
    name: 'MERN',
    short: 'MERN',
    detail: 'React client + Express API + MongoDB. Forms ke liye stub endpoints milenge.',
  },
];

export const stackById = (id) => STACKS.find((s) => s.id === id) ?? STACKS[0];

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
